import { prisma } from '../infra/db.js';
import { verifyPassword, needsRehash, hashPassword } from '../crypto/password.js';
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

