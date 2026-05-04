import { prisma } from '../infra/db.js';
import { verifyPassword, needsRehash, hashPassword } from '../crypto/password.js';
import { audit } from '../infra/audit.js';
import { AppError } from '../middleware/errors.js';
import { issueSession, type IssuedSession } from './sessions.js';

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

export async function login(input: LoginInput, ctx: LoginCtx = {}): Promise<IssuedSession> {
  const email = input.email.toLowerCase().trim();

  // Generic error — never reveal which of "no such email" vs "wrong password".
  const genericFail = new AppError(401, 'invalid_credentials', 'invalid email or password');

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
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
    const failedCount = user.failedLoginCount + 1;
    const shouldLock = failedCount >= MAX_FAILED_LOGINS;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: failedCount,
        lockedUntil: shouldLock ? new Date(Date.now() + LOCKOUT_DURATION_MS) : null,
      },
    });
    await audit({
      event: 'login.fail.bad_password',
      userId: user.id,
      ...ctx,
      metadata: { failedCount, locked: shouldLock },
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

  // TODO slice 5: if user has a confirmed MFA factor, return { mfaRequired, mfaToken }
  // and only issue the session after /v1/login/mfa succeeds.

  const result = await issueSession({
    userId: user.id,
    email: user.email,
    emailVerified: !!user.emailVerifiedAt,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  await audit({
    event: 'login.success',
    userId: user.id,
    ...ctx,
    metadata: { sessionId: result.sessionId },
  });
  return result;
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string, ctx: LoginCtx = {}): Promise<void> {
  // Used by /v1/password/change in slice 4. Lives here because it shares the
  // verify+rehash machinery with login.
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, 'not_found', 'user not found');

  const ok = await verifyPassword(user.passwordHash, currentPassword);
  if (!ok) {
    await audit({ event: 'password.change.fail', userId, ...ctx });
    throw new AppError(401, 'invalid_credentials', 'current password is incorrect');
  }

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword) },
  });
  // Revoke all existing sessions on password change.
  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await audit({ event: 'password.change', userId, ...ctx });
}
