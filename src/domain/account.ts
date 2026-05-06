import { prisma } from '../infra/db.js';
import { audit } from '../infra/audit.js';
import { sendEmail } from '../infra/email.js';
import { verifyPassword } from '../crypto/password.js';
import { generateToken, hashToken } from '../crypto/tokens.js';
import { env } from '../infra/env.js';
import { AppError } from '../middleware/errors.js';

// Self-service account deletion (two-step confirm) and a GDPR data-export
// dump. Both endpoints are scoped to the calling user — no admin power
// required, no targeting another user.
//
// Why the two-step: instant DELETE on a single endpoint is a cliff edge.
// A misclick or stolen access token alone shouldn't be able to wipe an
// account. Re-auth + emailed confirmation gives the user a "no, I didn't
// do that" gap and matches the password-reset / email-change pattern.

const DELETE_TOKEN_TTL_HOURS = 1;

interface RequestCtx {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

// ---------- request ----------

export async function requestAccountDeletion(
  userId: string,
  currentPassword: string,
  ctx: RequestCtx = {},
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, 'not_found', 'user not found');

  const ok = await verifyPassword(user.passwordHash, currentPassword);
  if (!ok) {
    await audit({ event: 'account.delete.fail.bad_password', userId, ...ctx });
    throw new AppError(401, 'invalid_credentials', 'current password is incorrect');
  }

  // Invalidate any prior unused deletion tokens — only the latest works.
  await prisma.emailToken.updateMany({
    where: { userId, type: 'ACCOUNT_DELETION', usedAt: null },
    data: { usedAt: new Date() },
  });

  const { plaintext, hash } = generateToken();
  const expiresAt = new Date(Date.now() + DELETE_TOKEN_TTL_HOURS * 3600 * 1000);
  await prisma.emailToken.create({
    data: { userId, type: 'ACCOUNT_DELETION', tokenHash: hash, expiresAt },
  });

  const link = `${env().WEB_BASE_URL.replace(/\/$/, '')}/account/delete/confirm?token=${plaintext}`;
  await sendEmail({
    to: user.email,
    template: 'account_deletion',
    vars: { link, token: plaintext, expires_hours: String(DELETE_TOKEN_TTL_HOURS) },
    clientId: user.registeredClientId,
  });

  await audit({ event: 'account.delete.requested', userId, ...ctx });
}

// ---------- confirm + delete ----------

// Hard-delete the user. All cascading children (Session, MfaFactor, EmailToken)
// drop with the row; AuditEvent.userId is set NULL via onDelete: SetNull so
// the audit trail survives anonymized — useful for security review and
// not regulated as PII once the user link is severed.
export async function confirmAccountDeletion(
  token: string,
  ctx: RequestCtx = {},
): Promise<void> {
  const tokenHash = hashToken(token);
  const invalid = new AppError(400, 'invalid_token', 'token is invalid or expired');

  const row = await prisma.emailToken.findUnique({ where: { tokenHash } });
  if (!row || row.type !== 'ACCOUNT_DELETION' || row.usedAt || row.expiresAt < new Date()) {
    throw invalid;
  }

  // Mark the token used in the same transaction as the delete to prevent
  // a parallel confirmer from finding a "used token but live user" state.
  await prisma.$transaction([
    prisma.emailToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
    prisma.user.delete({ where: { id: row.userId } }),
  ]);

  // Audit AFTER delete so the event has userId=null (from SetNull cascade).
  // We log the deleted user's id in metadata so admin can correlate.
  await audit({
    event: 'account.deleted',
    ...ctx,
    metadata: { deletedUserId: row.userId },
  });
}

// ---------- export (GDPR Article 15 — right of access) ----------

export interface UserDataExport {
  exportedAt: string;
  user: {
    id: string;
    email: string;
    status: string;
    emailVerifiedAt: string | null;
    createdAt: string;
    updatedAt: string;
    failedLoginCount: number;
    lockedUntil: string | null;
    registeredClientId: string | null;
  };
  sessions: Array<{
    id: string;
    ip: string | null;
    userAgent: string | null;
    createdAt: string;
    lastUsedAt: string | null;
    expiresAt: string;
    revokedAt: string | null;
  }>;
  mfaFactors: Array<{
    id: string;
    type: string;
    label: string | null;
    confirmedAt: string | null;
    createdAt: string;
    lastUsedAt: string | null;
  }>;
  emailTokens: Array<{
    id: string;
    type: string;
    expiresAt: string;
    usedAt: string | null;
    createdAt: string;
  }>;
  auditEvents: Array<{
    id: string;
    event: string;
    ip: string | null;
    userAgent: string | null;
    metadata: unknown;
    createdAt: string;
  }>;
}

// Returns the entirety of what we hold for a user, including secrets only as
// presence-flags (never plaintext): TOTP-secret bytes, refresh-token hashes,
// and password hashes are intentionally omitted. Audit metadata is included
// verbatim because it's already user-attributable and useful for the user.
export async function exportUserData(userId: string): Promise<UserDataExport> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, 'not_found', 'user not found');

  const [sessions, mfaFactors, emailTokens, auditEvents] = await Promise.all([
    prisma.session.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        ip: true,
        userAgent: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
      },
    }),
    prisma.mfaFactor.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        type: true,
        label: true,
        confirmedAt: true,
        createdAt: true,
        lastUsedAt: true,
      },
    }),
    prisma.emailToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, type: true, expiresAt: true, usedAt: true, createdAt: true },
    }),
    prisma.auditEvent.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 5000,
      select: {
        id: true,
        event: true,
        ip: true,
        userAgent: true,
        metadata: true,
        createdAt: true,
      },
    }),
  ]);

  const iso = (d: Date | null) => (d ? d.toISOString() : null);

  return {
    exportedAt: new Date().toISOString(),
    user: {
      id: user.id,
      email: user.email,
      status: user.status,
      emailVerifiedAt: iso(user.emailVerifiedAt),
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
      failedLoginCount: user.failedLoginCount,
      lockedUntil: iso(user.lockedUntil),
      registeredClientId: user.registeredClientId,
    },
    sessions: sessions.map((s) => ({
      id: s.id,
      ip: s.ip,
      userAgent: s.userAgent,
      createdAt: s.createdAt.toISOString(),
      lastUsedAt: iso(s.lastUsedAt),
      expiresAt: s.expiresAt.toISOString(),
      revokedAt: iso(s.revokedAt),
    })),
    mfaFactors: mfaFactors.map((f) => ({
      id: f.id,
      type: f.type,
      label: f.label,
      confirmedAt: iso(f.confirmedAt),
      createdAt: f.createdAt.toISOString(),
      lastUsedAt: iso(f.lastUsedAt),
    })),
    emailTokens: emailTokens.map((t) => ({
      id: t.id,
      type: t.type,
      expiresAt: t.expiresAt.toISOString(),
      usedAt: iso(t.usedAt),
      createdAt: t.createdAt.toISOString(),
    })),
    auditEvents: auditEvents.map((e) => ({
      id: e.id,
      event: e.event,
      ip: e.ip,
      userAgent: e.userAgent,
      metadata: e.metadata,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}
