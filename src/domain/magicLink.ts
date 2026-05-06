import { prisma } from '../infra/db.js';
import { audit } from '../infra/audit.js';
import { sendEmail } from '../infra/email.js';
import { generateToken, hashToken } from '../crypto/tokens.js';
import { env } from '../infra/env.js';
import { AppError } from '../middleware/errors.js';
import { issueSession, type IssuedSession, type IssueSessionInput } from './sessions.js';
import { userHasConfirmedMfa } from './mfa.js';
import { issueMfaChallenge } from '../crypto/signing.js';

// Magic-link login: user receives a one-shot URL by email, clicks it, gets a
// session. Tokens are 256-bit random strings (parity with verify-email and
// password-reset), sha256-hashed at rest, single-use, with a short TTL.
//
// 15 minutes is shorter than the 1h password-reset window because a magic
// link is full authentication, not just a key to set a new password. If MFA
// is enrolled the response funnels through the same /v1/login/mfa exchange
// so passwordless and password-based logins converge on one MFA flow.

const MAGIC_LINK_TOKEN_TTL_MIN = 15;

interface RequestCtx {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

// ---------- request ----------

// Always succeeds at the API level — never reveals whether the email exists.
// Callers receive the same 202 regardless of state, matching the
// register/forgot/resend pattern.
export async function requestMagicLink(emailIn: string, ctx: RequestCtx = {}): Promise<void> {
  const email = emailIn.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email } });

  // No-op for missing accounts, disabled users, and unverified emails. We
  // refuse to send a sign-in link to an unverified address — otherwise an
  // attacker who registered a victim's email could log in via magic link
  // before the victim ever clicked the verification link.
  if (!user || user.status !== 'ACTIVE' || !user.emailVerifiedAt) {
    await audit({ event: 'login.magic_link.request.noop', ...ctx });
    return;
  }

  // Invalidate any prior unused magic-link tokens — only the latest works.
  await prisma.emailToken.updateMany({
    where: { userId: user.id, type: 'LOGIN_MAGIC_LINK', usedAt: null },
    data: { usedAt: new Date() },
  });

  const { plaintext, hash } = generateToken();
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TOKEN_TTL_MIN * 60 * 1000);
  await prisma.emailToken.create({
    data: { userId: user.id, type: 'LOGIN_MAGIC_LINK', tokenHash: hash, expiresAt },
  });

  const link = `${env().WEB_BASE_URL.replace(/\/$/, '')}/login/magic?token=${plaintext}`;
  await sendEmail({
    to: email,
    template: 'magic_link',
    vars: {
      link,
      token: plaintext,
      expires_minutes: String(MAGIC_LINK_TOKEN_TTL_MIN),
    },
    clientId: user.registeredClientId,
  });

  await audit({ event: 'login.magic_link.request', userId: user.id, ...ctx });
}

// ---------- verify ----------

export type MagicLinkResult =
  | { kind: 'session'; session: IssuedSession }
  | { kind: 'mfa_required'; mfaToken: string };

// Exchange a one-shot magic-link token for a session. If the user has a
// confirmed MFA factor we hand back an mfa_token instead, mirroring the
// password-login flow — magic-link is treated as a first factor only.
export async function verifyMagicLink(
  token: string,
  ctx: RequestCtx = {},
): Promise<MagicLinkResult> {
  const tokenHash = hashToken(token);
  const invalid = new AppError(400, 'invalid_token', 'token is invalid or expired');

  // Atomic claim: updateMany scoped to (tokenHash, type, unused, unexpired)
  // marks the token used in a single statement so two parallel verifies
  // can't both succeed on one token.
  const claimed = await prisma.emailToken.updateMany({
    where: {
      tokenHash,
      type: 'LOGIN_MAGIC_LINK',
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { usedAt: new Date() },
  });
  if (claimed.count !== 1) throw invalid;

  // Re-fetch to get the userId; the returning row was claimed atomically.
  const row = await prisma.emailToken.findUnique({ where: { tokenHash } });
  if (!row) throw invalid;

  const user = await prisma.user.findUnique({ where: { id: row.userId } });
  if (!user || user.status !== 'ACTIVE') throw invalid;

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await audit({ event: 'login.magic_link.fail.locked', userId: user.id, ...ctx });
    throw new AppError(423, 'account_locked', 'account temporarily locked, try again later');
  }

  if (await userHasConfirmedMfa(user.id)) {
    const mfaToken = await issueMfaChallenge(user.id);
    await audit({ event: 'login.magic_link.mfa_required', userId: user.id, ...ctx });
    return { kind: 'mfa_required', mfaToken };
  }

  // Successful first-and-only factor — clear any prior failed-login state and
  // issue a normal session. Same end shape as /v1/login.
  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null },
  });

  const sessionInput: IssueSessionInput = {
    userId: user.id,
    email: user.email,
    emailVerified: !!user.emailVerifiedAt,
  };
  if (ctx.ip !== undefined) sessionInput.ip = ctx.ip;
  if (ctx.userAgent !== undefined) sessionInput.userAgent = ctx.userAgent;
  const session = await issueSession(sessionInput);

  await audit({
    event: 'login.magic_link.success',
    userId: user.id,
    ...ctx,
    metadata: { sessionId: session.sessionId },
  });
  return { kind: 'session', session };
}
