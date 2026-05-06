import { prisma } from '../infra/db.js';
import { audit } from '../infra/audit.js';
import { sendEmail } from '../infra/email.js';
import { verifyPassword } from '../crypto/password.js';
import { generateToken, hashToken } from '../crypto/tokens.js';
import { env } from '../infra/env.js';
import { AppError } from '../middleware/errors.js';

// Authenticated email-address change. The token goes to the *new* address —
// proof the user actually owns it — and only when they click does the User
// row's email column flip. Existing sessions are revoked on confirm because
// email is the recovery path for password reset; rotating it should re-assert
// presence on every device.
//
// Re-auth is required at request time (current_password) so a stolen access
// token alone can't redirect a user's recovery email. We deliberately don't
// also require MFA here: the caller already proved password+possession at
// login if MFA was enabled; the access token's existence is the proof.

const EMAIL_CHANGE_TTL_HOURS = 1;

interface RequestCtx {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

// ---------- request ----------

export interface RequestEmailChangeInput {
  userId: string;
  currentPassword: string;
  newEmail: string;
}

export async function requestEmailChange(
  input: RequestEmailChangeInput,
  ctx: RequestCtx = {},
): Promise<void> {
  const newEmail = input.newEmail.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user) throw new AppError(404, 'not_found', 'user not found');

  const ok = await verifyPassword(user.passwordHash, input.currentPassword);
  if (!ok) {
    await audit({ event: 'email.change.fail.bad_password', userId: user.id, ...ctx });
    throw new AppError(401, 'invalid_credentials', 'current password is incorrect');
  }

  // No-op if the new email is the same as the current one (after canonical
  // lowercase). Don't tell the caller — it's the same shape as success and
  // avoids leaking that they're already on this email.
  if (newEmail === user.email.toLowerCase()) {
    await audit({ event: 'email.change.noop.same', userId: user.id, ...ctx });
    return;
  }

  // Refuse if another account already has this email. Surfacing this *to the
  // logged-in user* is fine — they can already enumerate via the login form
  // anyway, and forcing them to fight unknown-collision errors is hostile.
  const existing = await prisma.user.findUnique({ where: { email: newEmail } });
  if (existing && existing.id !== user.id) {
    await audit({
      event: 'email.change.fail.email_in_use',
      userId: user.id,
      ...ctx,
      metadata: { newEmail },
    });
    throw new AppError(409, 'email_in_use', 'that email is already in use');
  }

  // Invalidate any prior unused requests — only the latest works.
  await prisma.emailChangeRequest.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  const { plaintext, hash } = generateToken();
  const expiresAt = new Date(Date.now() + EMAIL_CHANGE_TTL_HOURS * 3600 * 1000);
  await prisma.emailChangeRequest.create({
    data: { userId: user.id, newEmail, tokenHash: hash, expiresAt },
  });

  const link = `${env().WEB_BASE_URL.replace(/\/$/, '')}/email/change/confirm?token=${plaintext}`;
  await sendEmail({
    to: newEmail,
    template: 'email_change',
    vars: { link, token: plaintext, expires_hours: String(EMAIL_CHANGE_TTL_HOURS) },
    clientId: user.registeredClientId,
  });

  await audit({
    event: 'email.change.requested',
    userId: user.id,
    ...ctx,
    metadata: { newEmail },
  });
}

// ---------- confirm ----------

export interface ConfirmEmailChangeResult {
  newEmail: string;
}

export async function confirmEmailChange(
  token: string,
  ctx: RequestCtx = {},
): Promise<ConfirmEmailChangeResult> {
  const tokenHash = hashToken(token);
  const invalid = new AppError(400, 'invalid_token', 'token is invalid or expired');

  const row = await prisma.emailChangeRequest.findUnique({ where: { tokenHash } });
  if (!row || row.usedAt || row.expiresAt < new Date()) throw invalid;

  // Interactive transaction: claim the token AND re-check the destination
  // address inside one atomic context. Without this, two failure modes:
  //   (a) two parallel confirms could both pass the early "usedAt is null"
  //       check and both try to flip the email — second one would crash.
  //   (b) someone could register `bob@…` between our pre-check and the
  //       update, making prisma raise a P2002 unique-constraint error
  //       (→ 500 to the caller) instead of our intended 409.
  // The collision branch throws inside the tx so the token claim rolls back
  // and the user can request a new change.
  const now = new Date();
  const inUse = new AppError(409, 'email_in_use', 'that email is already in use');
  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.emailChangeRequest.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count === 0) throw invalid;

      const collision = await tx.user.findUnique({ where: { email: row.newEmail } });
      if (collision && collision.id !== row.userId) throw inUse;

      await tx.user.update({
        where: { id: row.userId },
        // The new address has just proven possession via this token, so it's
        // verified as of now. Existing emailVerifiedAt would be stale (refers
        // to the OLD address) — replace it.
        data: { email: row.newEmail, emailVerifiedAt: now },
      });

      // Email is the recovery path for password reset; rotating it should
      // log the user out of every device so they re-authenticate fresh.
      await tx.session.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: now },
      });
    });
  } catch (err) {
    if (err === inUse) {
      // Audit outside the tx so the entry survives the rollback.
      await audit({
        event: 'email.change.fail.email_in_use_at_confirm',
        userId: row.userId,
        ...ctx,
        metadata: { newEmail: row.newEmail },
      });
    }
    throw err;
  }

  await audit({
    event: 'email.change.confirmed',
    userId: row.userId,
    ...ctx,
    metadata: { newEmail: row.newEmail },
  });
  return { newEmail: row.newEmail };
}
