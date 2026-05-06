import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type GenerateRegistrationOptionsOpts,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/types';

import { prisma } from '../infra/db.js';
import { audit } from '../infra/audit.js';
import { AppError } from '../middleware/errors.js';
import { webauthnConfig } from '../crypto/webauthn.js';
import { issueWebauthnChallenge, verifyWebauthnChallenge } from '../crypto/signing.js';
import { issueSession, type IssuedSession, type IssueSessionInput } from './sessions.js';

interface RequestCtx {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

// Mirrors login.ts so passkey-auth failures share the lockout budget. Without
// this, a stolen credentialId could be replayed against `/v1/login/passkey/verify`
// indefinitely. Correctly-signed assertions practically can't fail, so any
// burst of failures is itself suspicious and worth locking on.
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

// `userID` for WebAuthn must be a stable per-user byte string ≤ 64 bytes.
// We use the User row's UUID encoded as raw bytes (16 bytes) so the value
// round-trips cleanly through `userHandle` on discoverable authentication.
function userIdToHandle(userId: string): Uint8Array {
  return Uint8Array.from(Buffer.from(userId.replace(/-/g, ''), 'hex'));
}

function handleToUserId(handle: Uint8Array | string | undefined): string | null {
  if (!handle) return null;
  const buf =
    typeof handle === 'string' ? Buffer.from(handle, 'base64url') : Buffer.from(handle);
  if (buf.length !== 16) return null;
  const hex = buf.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------- Register: start ----------

export interface PasskeyRegisterStart {
  options: PublicKeyCredentialCreationOptionsJSON;
  challengeToken: string;
}

export async function startPasskeyRegistration(
  userId: string,
  ctx: RequestCtx = {},
): Promise<PasskeyRegisterStart> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, 'not_found', 'user not found');

  // excludeCredentials prevents the user from accidentally enrolling the same
  // authenticator twice — the browser will refuse if any of these are present.
  const existing = await prisma.mfaFactor.findMany({
    where: { userId, type: 'WEBAUTHN', credentialId: { not: null } },
    select: { credentialId: true, transports: true },
  });

  const cfg = webauthnConfig();
  const opts: GenerateRegistrationOptionsOpts = {
    rpName: cfg.rpName,
    rpID: cfg.rpID,
    userName: user.email,
    userID: userIdToHandle(userId),
    attestationType: 'none', // we don't need attestation; reduces friction
    authenticatorSelection: {
      // Prefer platform / synced credentials but allow roaming security keys.
      residentKey: 'preferred',
      userVerification: 'required',
    },
    excludeCredentials: existing
      .filter((f) => f.credentialId)
      .map((f) => ({
        id: Buffer.from(f.credentialId!).toString('base64url'),
        // transports is `String[]` in DB; cast at the interop boundary.
        transports: f.transports as AuthenticatorTransportFuture[],
      })),
  };

  const options = await generateRegistrationOptions(opts);
  const challengeToken = await issueWebauthnChallenge({
    purpose: 'register',
    chal: options.challenge,
    userId,
  });

  await audit({ event: 'mfa.passkey.register.start', userId, ...ctx });
  return { options, challengeToken };
}

// ---------- Register: verify ----------

export interface PasskeyRegisterVerifyInput {
  userId: string;
  challengeToken: string;
  response: RegistrationResponseJSON;
  label?: string | undefined;
}

export async function verifyPasskeyRegistration(
  input: PasskeyRegisterVerifyInput,
  ctx: RequestCtx = {},
): Promise<{ factorId: string }> {
  const claims = await verifyWebauthnChallenge(input.challengeToken).catch(() => null);
  if (!claims || claims.purpose !== 'register' || claims.sub !== input.userId) {
    throw new AppError(400, 'invalid_challenge', 'webauthn challenge invalid or expired');
  }

  const cfg = webauthnConfig();
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: claims.chal,
      expectedOrigin: cfg.origins,
      expectedRPID: cfg.rpID,
      requireUserVerification: true,
    });
  } catch (err) {
    await audit({
      event: 'mfa.passkey.register.fail',
      userId: input.userId,
      ...ctx,
      metadata: { reason: (err as Error).message },
    });
    throw new AppError(400, 'invalid_response', 'webauthn registration failed');
  }

  if (!verification.verified || !verification.registrationInfo) {
    throw new AppError(400, 'invalid_response', 'webauthn registration not verified');
  }

  const info = verification.registrationInfo;
  const factor = await prisma.mfaFactor.create({
    data: {
      userId: input.userId,
      type: 'WEBAUTHN',
      label: input.label ?? null,
      credentialId: Buffer.from(info.credentialID, 'base64url'),
      publicKey: Buffer.from(info.credentialPublicKey),
      signCount: info.counter,
      transports: input.response.response.transports ?? [],
      aaguid: info.aaguid,
      confirmedAt: new Date(),
      lastUsedAt: new Date(),
    },
  });

  await audit({ event: 'mfa.passkey.registered', userId: input.userId, ...ctx });
  return { factorId: factor.id };
}

// ---------- Delete ----------

export async function deletePasskey(
  userId: string,
  factorId: string,
  ctx: RequestCtx = {},
): Promise<void> {
  const result = await prisma.mfaFactor.deleteMany({
    where: { id: factorId, userId, type: 'WEBAUTHN' },
  });
  if (result.count > 0) {
    await audit({ event: 'mfa.passkey.deleted', userId, ...ctx });
  }
}

// ---------- List ----------

export interface PasskeyListItem {
  id: string;
  label: string | null;
  aaguid: string | null;
  transports: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
}

export async function listPasskeys(userId: string): Promise<PasskeyListItem[]> {
  const rows = await prisma.mfaFactor.findMany({
    where: { userId, type: 'WEBAUTHN', confirmedAt: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      label: true,
      aaguid: true,
      transports: true,
      createdAt: true,
      lastUsedAt: true,
    },
  });
  return rows;
}

// ---------- Login: start (discoverable) ----------

export interface PasskeyLoginStart {
  options: PublicKeyCredentialRequestOptionsJSON;
  challengeToken: string;
}

export async function startPasskeyLogin(): Promise<PasskeyLoginStart> {
  const cfg = webauthnConfig();
  // Discoverable flow: no allowCredentials, browser shows a credential picker.
  // The verify step uses `userHandle` from the assertion to find the user.
  const options = await generateAuthenticationOptions({
    rpID: cfg.rpID,
    userVerification: 'required',
  });
  const challengeToken = await issueWebauthnChallenge({
    purpose: 'authenticate',
    chal: options.challenge,
  });
  return { options, challengeToken };
}

// ---------- Login: verify ----------

export interface PasskeyLoginVerifyInput {
  challengeToken: string;
  response: AuthenticationResponseJSON;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export async function verifyPasskeyLogin(
  input: PasskeyLoginVerifyInput,
): Promise<IssuedSession> {
  const ctx = { ip: input.ip, userAgent: input.userAgent };
  const invalid = new AppError(401, 'invalid_credential', 'passkey login failed');

  const claims = await verifyWebauthnChallenge(input.challengeToken).catch(() => null);
  if (!claims || claims.purpose !== 'authenticate') throw invalid;

  // Resolve the user from the credential's userHandle (set at registration).
  const userId = handleToUserId(input.response.response.userHandle);
  if (!userId) throw invalid;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.status !== 'ACTIVE') throw invalid;

  // Reuse the same lockout that protects password+TOTP — passkey assertions
  // shouldn't ever legitimately fail, so any churn here is suspicious.
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await audit({ event: 'login.passkey.fail.locked', userId, ...ctx });
    throw new AppError(423, 'account_locked', 'account temporarily locked, try again later');
  }

  const credentialId = Buffer.from(input.response.id, 'base64url');
  const factor = await prisma.mfaFactor.findFirst({
    where: {
      userId,
      type: 'WEBAUTHN',
      credentialId,
      confirmedAt: { not: null },
    },
  });
  if (!factor || !factor.credentialId || !factor.publicKey) throw invalid;

  const cfg = webauthnConfig();
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: claims.chal,
      expectedOrigin: cfg.origins,
      expectedRPID: cfg.rpID,
      authenticator: {
        credentialID: Buffer.from(factor.credentialId).toString('base64url'),
        credentialPublicKey: new Uint8Array(factor.publicKey),
        counter: factor.signCount ?? 0,
      },
      requireUserVerification: true,
    });
  } catch {
    await recordPasskeyFailure(userId, ctx);
    throw invalid;
  }

  if (!verification.verified || !verification.authenticationInfo) {
    await recordPasskeyFailure(userId, ctx);
    throw invalid;
  }

  // Counter regression = possible cloned authenticator. Both must increment
  // monotonically per spec; equality is allowed for some authenticators but
  // a strictly-decreasing value is grounds for revocation.
  const newCounter = verification.authenticationInfo.newCounter;
  if (newCounter < (factor.signCount ?? 0)) {
    await audit({
      event: 'login.passkey.fail.counter_regression',
      userId,
      ...ctx,
      metadata: { stored: factor.signCount, received: newCounter },
    });
    throw invalid;
  }

  await prisma.mfaFactor.update({
    where: { id: factor.id },
    data: { signCount: newCounter, lastUsedAt: new Date() },
  });

  // Success: clear any prior lockout state (mirrors password+TOTP success).
  await prisma.user.update({
    where: { id: userId },
    data: { failedLoginCount: 0, lockedUntil: null },
  });

  // exactOptionalPropertyTypes is finicky about optional fields constructed
  // via spreads — build the input via mutation on a typed local instead.
  const sessionInput: IssueSessionInput = {
    userId,
    email: user.email,
    emailVerified: !!user.emailVerifiedAt,
    role: user.role,
  };
  if (input.ip !== undefined) sessionInput.ip = input.ip;
  if (input.userAgent !== undefined) sessionInput.userAgent = input.userAgent;
  const session = await issueSession(sessionInput);

  await audit({
    event: 'login.passkey.success',
    userId,
    ...ctx,
    metadata: { sessionId: session.sessionId, factorId: factor.id },
  });
  return session;
}

async function recordPasskeyFailure(userId: string, ctx: RequestCtx): Promise<void> {
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { failedLoginCount: { increment: 1 } },
    select: { failedLoginCount: true },
  });
  const locked = updated.failedLoginCount >= MAX_FAILED_LOGINS;
  if (locked) {
    await prisma.user.update({
      where: { id: userId },
      data: { lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS) },
    });
  }
  await audit({
    event: 'login.passkey.fail',
    userId,
    ...ctx,
    metadata: { failedCount: updated.failedLoginCount, locked },
  });
}
