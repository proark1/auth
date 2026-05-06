import { prisma } from '../infra/db.js';
import { audit } from '../infra/audit.js';
import { env } from '../infra/env.js';
import { AppError } from '../middleware/errors.js';
import {
  generateTotpSecret,
  totpKeyuri,
  verifyTotp,
  encryptTotpSecret,
  decryptTotpSecret,
} from '../crypto/totp.js';
import { verifyMfaChallenge } from '../crypto/signing.js';
import { issueSession, type IssuedSession } from './sessions.js';

interface RequestCtx {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

// Mirrors login.ts. MFA failures share the password failed-login counter so
// an attacker who already has the password can't brute-force the 6-digit
// TOTP code from a pool of IPs while a single mfa_token is alive.
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

// ---------- TOTP setup ----------

export interface TotpSetupResult {
  factorId: string;
  secret: string;       // base32, shown once
  otpauthUri: string;   // for QR display
}

export async function setupTotp(
  userId: string,
  label: string | undefined,
  ctx: RequestCtx = {},
): Promise<TotpSetupResult> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, 'not_found', 'user not found');

  const secret = generateTotpSecret();
  const factor = await prisma.mfaFactor.create({
    data: {
      userId,
      type: 'TOTP',
      label: label ?? null,
      totpSecretEnc: encryptTotpSecret(secret),
    },
  });

  // Issuer label for the authenticator app — use the issuer URL host.
  const issuer = new URL(env().JWT_ISSUER).hostname;
  const otpauthUri = totpKeyuri({ account: user.email, issuer, secret });

  await audit({ event: 'mfa.totp.setup', userId, ...ctx });
  return { factorId: factor.id, secret, otpauthUri };
}

// ---------- TOTP confirm ----------

export async function confirmTotp(
  userId: string,
  factorId: string,
  code: string,
  ctx: RequestCtx = {},
): Promise<void> {
  const factor = await prisma.mfaFactor.findUnique({ where: { id: factorId } });
  if (!factor || factor.userId !== userId || factor.type !== 'TOTP' || !factor.totpSecretEnc) {
    throw new AppError(400, 'invalid_factor', 'unknown MFA factor');
  }
  if (factor.confirmedAt) {
    throw new AppError(400, 'already_confirmed', 'factor already confirmed');
  }
  const secret = decryptTotpSecret(Buffer.from(factor.totpSecretEnc));
  if (!verifyTotp(secret, code)) {
    await audit({ event: 'mfa.totp.confirm.fail', userId, ...ctx });
    throw new AppError(400, 'invalid_code', 'invalid TOTP code');
  }
  await prisma.mfaFactor.update({
    where: { id: factor.id },
    data: { confirmedAt: new Date(), lastUsedAt: new Date() },
  });
  await audit({ event: 'mfa.totp.confirm', userId, ...ctx });
}

// ---------- TOTP delete ----------

export async function deleteTotp(userId: string, factorId: string, ctx: RequestCtx = {}): Promise<void> {
  const result = await prisma.mfaFactor.deleteMany({
    where: { id: factorId, userId, type: 'TOTP' },
  });
  if (result.count > 0) {
    await audit({ event: 'mfa.totp.deleted', userId, ...ctx });
  }
}

export async function userHasConfirmedMfa(userId: string): Promise<boolean> {
  const f = await prisma.mfaFactor.findFirst({
    where: { userId, confirmedAt: { not: null } },
    select: { id: true },
  });
  return !!f;
}

// ---------- /v1/login/mfa ----------

export interface CompleteMfaInput {
  mfaToken: string;
  code: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export async function completeMfaLogin(input: CompleteMfaInput): Promise<IssuedSession> {
  const invalid = new AppError(401, 'invalid_token', 'mfa token invalid or expired');

  let claims;
  try {
    claims = await verifyMfaChallenge(input.mfaToken);
  } catch {
    throw invalid;
  }
  if (claims.typ !== 'mfa') throw invalid;

  const userId = claims.sub;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.status !== 'ACTIVE') throw invalid;

  // Re-check lockout: a user can be locked between /v1/login and /v1/login/mfa
  // (e.g. another attacker hammering passwords). The mfa_token alone must not
  // bypass the lock.
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await audit({
      event: 'login.mfa.fail.locked',
      userId,
      ip: input.ip,
      userAgent: input.userAgent,
    });
    throw new AppError(423, 'account_locked', 'account temporarily locked, try again later');
  }

  const factors = await prisma.mfaFactor.findMany({
    where: { userId, type: 'TOTP', confirmedAt: { not: null } },
  });
  if (factors.length === 0) {
    // Defensive: user reached MFA exchange without a factor. Shouldn't happen
    // unless the factor was deleted between /login and /login/mfa.
    throw invalid;
  }

  // Try the code against each confirmed factor. Constant-ish work; users
  // generally have one factor. Multiple factors here = future "second key".
  let matched = null;
  for (const f of factors) {
    if (!f.totpSecretEnc) continue;
    const secret = decryptTotpSecret(Buffer.from(f.totpSecretEnc));
    if (verifyTotp(secret, input.code)) {
      matched = f;
      break;
    }
  }

  if (!matched) {
    // Bump the shared failed-login counter so MFA brute-force triggers the
    // same lockout as password brute-force. The mfa_token stays valid for its
    // full TTL, but lockout cuts off code-guessing across IPs.
    //
    // Atomic increment: concurrent failed attempts from rotating IPs would
    // otherwise all read the same stale failedLoginCount and each write back
    // `stale + 1`, letting the attacker exceed MAX_FAILED_LOGINS before the
    // lockout fires.
    const updated = await prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    const shouldLock = updated.failedLoginCount >= MAX_FAILED_LOGINS;
    if (shouldLock) {
      await prisma.user.update({
        where: { id: userId },
        data: { lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS) },
      });
    }
    await audit({
      event: 'login.mfa.fail',
      userId,
      ip: input.ip,
      userAgent: input.userAgent,
      metadata: { failedCount: updated.failedLoginCount, locked: shouldLock },
    });
    throw new AppError(401, 'invalid_code', 'invalid TOTP code');
  }

  // Success: always reset the shared counter. Skipping based on the local
  // (potentially stale) `user` row would miss the case where concurrent
  // failures bumped the DB value while we were verifying the code.
  await prisma.user.update({
    where: { id: userId },
    data: { failedLoginCount: 0, lockedUntil: null },
  });

  await prisma.mfaFactor.update({
    where: { id: matched.id },
    data: { lastUsedAt: new Date() },
  });

  // Re-fetch the user to pick up the latest roles for the JWT — the row read
  // at the start of completeMfaLogin came in via resolveMfaChallenge which
  // selects a narrow shape.
  const fresh = await prisma.user.findUnique({
    where: { id: userId },
    select: { roles: true },
  });

  const session = await issueSession({
    userId,
    email: user.email,
    emailVerified: !!user.emailVerifiedAt,
    roles: fresh?.roles ?? [],
    ip: input.ip,
    userAgent: input.userAgent,
  });

  await audit({
    event: 'login.mfa.success',
    userId,
    ip: input.ip,
    userAgent: input.userAgent,
    metadata: { sessionId: session.sessionId },
  });
  return session;
}
