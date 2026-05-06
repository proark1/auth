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
import { consumeBackupCode, countUnusedBackupCodes } from './backupCodes.js';

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

interface MfaChallengeUser {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
  role: import('@prisma/client').Role;
  registeredClientId: string | null;
}

// Shared preamble for both TOTP and backup-code completion paths: validate the
// mfa_token, look up the user, and re-check the lockout. Returns the user on
// success; throws the appropriate AppError otherwise.
async function resolveMfaChallenge(
  mfaToken: string,
  ctx: { ip?: string | undefined; userAgent?: string | undefined },
): Promise<MfaChallengeUser> {
  const invalid = new AppError(401, 'invalid_token', 'mfa token invalid or expired');
  let claims;
  try {
    claims = await verifyMfaChallenge(mfaToken);
  } catch {
    throw invalid;
  }
  if (claims.typ !== 'mfa') throw invalid;

  const userId = claims.sub;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.status !== 'ACTIVE') throw invalid;

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await audit({ event: 'login.mfa.fail.locked', userId, ...ctx });
    throw new AppError(423, 'account_locked', 'account temporarily locked, try again later');
  }
  return {
    id: user.id,
    email: user.email,
    emailVerifiedAt: user.emailVerifiedAt,
    role: user.role,
    registeredClientId: user.registeredClientId,
  };
}

// Atomic-increment failed counter and lock the account on threshold. Mirrors
// login.ts so password and MFA brute-force share the same lockout budget.
async function recordMfaFailure(
  userId: string,
  event: string,
  ctx: { ip?: string | undefined; userAgent?: string | undefined },
): Promise<{ failedCount: number; locked: boolean }> {
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
    event,
    userId,
    ...ctx,
    metadata: { failedCount: updated.failedLoginCount, locked },
  });
  return { failedCount: updated.failedLoginCount, locked };
}

export interface CompleteMfaInput {
  mfaToken: string;
  code: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export async function completeMfaLogin(input: CompleteMfaInput): Promise<IssuedSession> {
  const ctx = { ip: input.ip, userAgent: input.userAgent };
  const user = await resolveMfaChallenge(input.mfaToken, ctx);

  const factors = await prisma.mfaFactor.findMany({
    where: { userId: user.id, type: 'TOTP', confirmedAt: { not: null } },
  });
  if (factors.length === 0) {
    // Defensive: user reached MFA exchange without a factor. Shouldn't happen
    // unless the factor was deleted between /login and /login/mfa.
    throw new AppError(401, 'invalid_token', 'mfa token invalid or expired');
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
    await recordMfaFailure(user.id, 'login.mfa.fail', ctx);
    throw new AppError(401, 'invalid_code', 'invalid TOTP code');
  }

  // Success: always reset the shared counter. Skipping based on the local
  // (potentially stale) `user` row would miss the case where concurrent
  // failures bumped the DB value while we were verifying the code.
  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null },
  });

  await prisma.mfaFactor.update({
    where: { id: matched.id },
    data: { lastUsedAt: new Date() },
  });

  const session = await issueSession({
    userId: user.id,
    email: user.email,
    emailVerified: !!user.emailVerifiedAt,
    role: user.role,
    ip: input.ip,
    userAgent: input.userAgent,
    registeredClientId: user.registeredClientId,
    loggedInVia: 'password+totp',
  });

  await audit({
    event: 'login.mfa.success',
    userId: user.id,
    ...ctx,
    metadata: { sessionId: session.sessionId },
  });
  return session;
}

// ---------- /v1/login/mfa/recovery (backup-code path) ----------

export interface CompleteMfaWithBackupInput {
  mfaToken: string;
  backupCode: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

// Backup codes are a fallback path: a user who has lost their TOTP device
// proves possession of one of the codes they printed out at enrollment. The
// rate-limit + atomic lockout machinery is identical to TOTP failures so this
// can't be abused as an easier brute-force surface (50-bit codes vs 6-digit
// TOTP, but we still cap attempts).
export async function completeMfaLoginWithBackupCode(
  input: CompleteMfaWithBackupInput,
): Promise<IssuedSession> {
  const ctx = { ip: input.ip, userAgent: input.userAgent };
  const user = await resolveMfaChallenge(input.mfaToken, ctx);

  const consumed = await consumeBackupCode(user.id, input.backupCode);
  if (!consumed) {
    await recordMfaFailure(user.id, 'login.mfa.backup.fail', ctx);
    throw new AppError(401, 'invalid_code', 'invalid recovery code');
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null },
  });

  const session = await issueSession({
    userId: user.id,
    email: user.email,
    emailVerified: !!user.emailVerifiedAt,
    role: user.role,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  // Caller should be nudged to regenerate when codes run low; surface the
  // remaining count in the audit metadata for ops visibility.
  const remaining = await countUnusedBackupCodes(user.id);
  await audit({
    event: 'login.mfa.backup.success',
    userId: user.id,
    ...ctx,
    metadata: { sessionId: session.sessionId, remainingBackupCodes: remaining },
  });
  return session;
}
