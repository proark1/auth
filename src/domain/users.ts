import { prisma } from '../infra/db.js';
import { audit } from '../infra/audit.js';
import { sendEmail, resolveWebBaseUrl } from '../infra/email.js';
import { hashPassword } from '../crypto/password.js';
import { isPasswordCompromised } from '../crypto/hibp.js';
import { generateToken, hashToken } from '../crypto/tokens.js';
import { AppError, errors } from '../middleware/errors.js';

const VERIFY_TOKEN_TTL_HOURS = 24;

interface RequestCtx {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

// ---------- register ----------

export interface RegisterInput {
  email: string;
  password: string;
  // ServiceClient.id of the app proxying this registration. Determines
  // email branding (from address, subject) for verification + future
  // password resets. Resolved server-side from the caller's s2s token.
  registeredClientId?: string | null;
}

// Always returns 202-shaped result. We never reveal whether the email existed
// (user-enumeration protection).
export async function registerUser(input: RegisterInput, ctx: RequestCtx = {}): Promise<void> {
  const email = input.email.toLowerCase().trim();
  const registeredClientId = input.registeredClientId ?? null;

  // Reject passwords known to be in public breach corpora. This is the only
  // pre-existence check that runs *before* the duplicate-email branch — even
  // a no-op duplicate response shouldn't accept a known-leaked password,
  // since the caller might be trying to reset it. Fail-open semantics live
  // inside isPasswordCompromised (HIBP down → no rejection).
  if (await isPasswordCompromised(input.password)) {
    await audit({ event: 'user.register.fail.compromised_password', metadata: { email }, ...ctx });
    throw new AppError(
      400,
      'compromised_password',
      'this password has appeared in known data breaches; please choose another',
    );
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // Don't tell the caller. If unverified, send a fresh verification email.
    if (!existing.emailVerifiedAt) {
      await issueVerificationEmail(existing.id, email, existing.registeredClientId);
    }
    await audit({ event: 'user.register.duplicate', userId: existing.id, ...ctx });
    return;
  }

  const passwordHash = await hashPassword(input.password);
  const user = await prisma.user.create({
    data: { email, passwordHash, status: 'PENDING', registeredClientId },
  });

  await issueVerificationEmail(user.id, email, registeredClientId);
  await audit({ event: 'user.registered', userId: user.id, ...ctx });
}

// ---------- verify email ----------

export async function verifyEmail(token: string, ctx: RequestCtx = {}): Promise<void> {
  const tokenHash = hashToken(token);

  const row = await prisma.emailToken.findUnique({ where: { tokenHash } });
  if (!row || row.type !== 'VERIFY_EMAIL' || row.usedAt || row.expiresAt < new Date()) {
    throw errors.invalidToken();
  }

  await prisma.$transaction([
    prisma.emailToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    prisma.user.update({
      where: { id: row.userId },
      data: { emailVerifiedAt: new Date(), status: 'ACTIVE' },
    }),
  ]);

  await audit({ event: 'user.email_verified', userId: row.userId, ...ctx });
}

// ---------- resend verification ----------

export async function resendVerification(emailIn: string, ctx: RequestCtx = {}): Promise<void> {
  const email = emailIn.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email } });

  // Silent on unknown email or already-verified user — don't leak status.
  if (!user || user.emailVerifiedAt) {
    await audit({ event: 'user.verification.resend.noop', ...ctx, metadata: { email } });
    return;
  }

  await issueVerificationEmail(user.id, email, user.registeredClientId);
  await audit({ event: 'user.verification.resend', userId: user.id, ...ctx });
}

// ---------- shared ----------

async function issueVerificationEmail(
  userId: string,
  email: string,
  registeredClientId: string | null,
): Promise<void> {
  // Invalidate prior unused verify tokens so only the latest works.
  await prisma.emailToken.updateMany({
    where: { userId, type: 'VERIFY_EMAIL', usedAt: null },
    data: { usedAt: new Date() },
  });

  const { plaintext, hash } = generateToken();
  const expiresAt = new Date(Date.now() + VERIFY_TOKEN_TTL_HOURS * 3600 * 1000);

  await prisma.emailToken.create({
    data: { userId, type: 'VERIFY_EMAIL', tokenHash: hash, expiresAt },
  });

  const base = await resolveWebBaseUrl(registeredClientId);
  const link = `${base}/verify-email?token=${plaintext}`;
  await sendEmail({
    to: email,
    template: 'verify_email',
    vars: { link, token: plaintext, expires_hours: String(VERIFY_TOKEN_TTL_HOURS) },
    clientId: registeredClientId,
  });
}
