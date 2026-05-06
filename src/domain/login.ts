import { prisma } from '../infra/db.js';
import {
  verifyPassword,
  needsRehash,
  hashPassword,
  verifyDummyPassword,
} from '../crypto/password.js';
import { audit } from '../infra/audit.js';
import { AppError } from '../middleware/errors.js';
import { issueSession, type IssuedSession } from './sessions.js';
import { userHasConfirmedMfa } from './mfa.js';
import { issueMfaChallenge } from '../crypto/signing.js';
// changePassword moved to ./password.ts; see there for the authenticated flow.

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginCtx {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export type LoginResult =
  | { kind: 'session'; session: IssuedSession }
  | { kind: 'mfa_required'; mfaToken: string };

export async function login(input: LoginInput, ctx: LoginCtx = {}): Promise<LoginResult> {
  const email = input.email.toLowerCase().trim();

  // Generic error — never reveal which of "no such email" vs "wrong password".
  const genericFail = new AppError(401, 'invalid_credentials', 'invalid email or password');

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    // Equalize timing with the wrong-password branch (~argon2.verify cost).
    // Otherwise the no-user branch returns ~50ms faster and leaks account
    // existence even though the response is identical.
    await verifyDummyPassword(input.password);
    await audit({ event: 'login.fail.unknown_email', metadata: { email }, ...ctx });
    throw genericFail;
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await audit({ event: 'login.fail.locked', userId: user.id, ...ctx });
    throw new AppError(423, 'account_locked', 'account temporarily locked, try again later');
  }

  if (user.status === 'DISABLED') {
    await audit({ event: 'login.fail.disabled', userId: user.id, ...ctx });
    throw new AppError(403, 'account_disabled', 'account is disabled');
  }

  const passwordOk = await verifyPassword(user.passwordHash, input.password);
  if (!passwordOk) {
    // Atomic increment: concurrent failed attempts would otherwise all read
    // the same stale failedLoginCount and each write back `stale + 1`,
    // exceeding MAX_FAILED_LOGINS before the lockout actually engages.
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    const shouldLock = updated.failedLoginCount >= MAX_FAILED_LOGINS;
    if (shouldLock) {
      await prisma.user.update({
        where: { id: user.id },
        data: { lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS) },
      });
    }
    await audit({
      event: 'login.fail.bad_password',
      userId: user.id,
      ...ctx,
      metadata: { failedCount: updated.failedLoginCount, locked: shouldLock },
    });
    throw genericFail;
  }

  if (user.status === 'PENDING') {
    await audit({ event: 'login.fail.unverified', userId: user.id, ...ctx });
    throw new AppError(403, 'email_not_verified', 'email is not verified');
  }

  // Success path. Reset lockout state and opportunistically rehash if Argon2
  // params have been bumped since the user's last login.
  const updates: Parameters<typeof prisma.user.update>[0]['data'] = {};
  if (user.failedLoginCount > 0) updates.failedLoginCount = 0;
  if (user.lockedUntil) updates.lockedUntil = null;
  if (needsRehash(user.passwordHash)) {
    updates.passwordHash = await hashPassword(input.password);
  }
  if (Object.keys(updates).length > 0) {
    await prisma.user.update({ where: { id: user.id }, data: updates });
  }

  // If the user has a confirmed MFA factor, do NOT issue a session yet.
  // Hand back a short-lived MFA challenge token; the caller must complete
  // /v1/login/mfa with a valid TOTP code to receive tokens.
  if (await userHasConfirmedMfa(user.id)) {
    const mfaToken = await issueMfaChallenge(user.id);
    await audit({ event: 'login.mfa_required', userId: user.id, ...ctx });
    return { kind: 'mfa_required', mfaToken };
  }

  const result = await issueSession({
    userId: user.id,
    email: user.email,
    emailVerified: !!user.emailVerifiedAt,
    role: user.role,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  await audit({
    event: 'login.success',
    userId: user.id,
    ...ctx,
    metadata: { sessionId: result.sessionId },
  });
  return { kind: 'session', session: result };
}

