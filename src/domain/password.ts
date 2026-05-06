import { prisma } from '../infra/db.js';
import { audit } from '../infra/audit.js';
import { sendEmail } from '../infra/email.js';
import { hashPassword, verifyPassword } from '../crypto/password.js';
import { isPasswordCompromised } from '../crypto/hibp.js';
import { generateToken, hashToken } from '../crypto/tokens.js';
import { env } from '../infra/env.js';
import { AppError } from '../middleware/errors.js';

const RESET_TOKEN_TTL_HOURS = 1;

interface RequestCtx {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

// ---------- forgot ----------

// Always succeeds at the API level — never reveals whether the email exists.
export async function forgotPassword(emailIn: string, ctx: RequestCtx = {}): Promise<void> {
  const email = emailIn.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || user.status === 'DISABLED') {
    // Don't persist the attacker-supplied email here: an attacker probing for
    // accounts can otherwise write unbounded user-controlled strings into the
    // audit log. IP + UA from ctx are enough to rate-limit / investigate.
    await audit({ event: 'password.forgot.noop', ...ctx });
    return;
  }

  // Invalidate prior unused reset tokens — only the latest works.
  await prisma.emailToken.updateMany({
    where: { userId: user.id, type: 'PASSWORD_RESET', usedAt: null },
    data: { usedAt: new Date() },
  });

  const { plaintext, hash } = generateToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_HOURS * 3600 * 1000);
  await prisma.emailToken.create({
    data: { userId: user.id, type: 'PASSWORD_RESET', tokenHash: hash, expiresAt },
  });

  const link = `${env().WEB_BASE_URL.replace(/\/$/, '')}/password/reset?token=${plaintext}`;
  await sendEmail({
    to: email,
    template: 'password_reset',
    vars: { link, token: plaintext, expires_hours: String(RESET_TOKEN_TTL_HOURS) },
    clientId: user.registeredClientId,
  });

  await audit({ event: 'password.forgot', userId: user.id, ...ctx });
}

// ---------- reset (via emailed token) ----------

export async function resetPassword(token: string, newPassword: string, ctx: RequestCtx = {}): Promise<void> {
  const tokenHash = hashToken(token);
  const row = await prisma.emailToken.findUnique({ where: { tokenHash } });

  const invalid = new AppError(400, 'invalid_token', 'token is invalid or expired');
  if (!row || row.type !== 'PASSWORD_RESET' || row.usedAt || row.expiresAt < new Date()) {
    throw invalid;
  }

  if (await isPasswordCompromised(newPassword)) {
    await audit({ event: 'password.reset.fail.compromised_password', userId: row.userId, ...ctx });
    throw new AppError(
      400,
      'compromised_password',
      'this password has appeared in known data breaches; please choose another',
    );
  }

  const passwordHash = await hashPassword(newPassword);
  const now = new Date();

  await prisma.$transaction([
    prisma.emailToken.update({ where: { id: row.id }, data: { usedAt: now } }),
    prisma.user.update({
      where: { id: row.userId },
      data: { passwordHash, failedLoginCount: 0, lockedUntil: null },
    }),
    // Revoke every active session — a forgotten password may indicate account
    // compromise; force a fresh login on every device.
    prisma.session.updateMany({
      where: { userId: row.userId, revokedAt: null },
      data: { revokedAt: now },
    }),
  ]);

  await audit({ event: 'password.reset', userId: row.userId, ...ctx });
}

// ---------- change (authenticated) ----------

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  ctx: RequestCtx = {},
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, 'not_found', 'user not found');

  const ok = await verifyPassword(user.passwordHash, currentPassword);
  if (!ok) {
    await audit({ event: 'password.change.fail', userId, ...ctx });
    throw new AppError(401, 'invalid_credentials', 'current password is incorrect');
  }

  if (await isPasswordCompromised(newPassword)) {
    await audit({ event: 'password.change.fail.compromised_password', userId, ...ctx });
    throw new AppError(
      400,
      'compromised_password',
      'this password has appeared in known data breaches; please choose another',
    );
  }

  const now = new Date();
  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
    prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    }),
  ]);

  await audit({ event: 'password.change', userId, ...ctx });
}
