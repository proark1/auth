import { prisma } from '../infra/db.js';
import { generateToken, hashToken } from '../crypto/tokens.js';
import { issueAccessToken } from '../crypto/signing.js';
import { env } from '../infra/env.js';
import { audit } from '../infra/audit.js';
import { AppError } from '../middleware/errors.js';

export interface IssueSessionInput {
  userId: string;
  email: string;
  emailVerified: boolean;
  // Stamped into the access token's `roles` claim. Each session re-fetches
  // the user's current roles so a privilege change takes effect on the next
  // refresh-token rotation (≤ refresh-token TTL latency, currently 30 days).
  roles?: string[] | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  sessionId: string;
}

// Creates a new Session row and signs a fresh access token.
// The plaintext refresh token is returned only here — never stored, never logged.
export async function issueSession(input: IssueSessionInput): Promise<IssuedSession> {
  const e = env();
  const { plaintext: refreshToken, hash } = generateToken();
  const expiresAt = new Date(Date.now() + e.REFRESH_TOKEN_TTL_SECONDS * 1000);

  const session = await prisma.session.create({
    data: {
      userId: input.userId,
      refreshTokenHash: hash,
      expiresAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    },
  });

  const accessToken = await issueAccessToken({
    sub: input.userId,
    email: input.email,
    emailVerified: input.emailVerified,
    ...(input.roles !== undefined ? { roles: input.roles } : {}),
  });

  return { accessToken, refreshToken, refreshTokenExpiresAt: expiresAt, sessionId: session.id };
}

export interface RotateCtx {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

// Refresh-token rotation with replay detection.
// If the incoming token has already been used, treat it as theft and revoke
// every session for that user (defense over convenience).
export async function rotateSession(refreshTokenPlain: string, ctx: RotateCtx = {}): Promise<IssuedSession> {
  const tokenHash = hashToken(refreshTokenPlain);
  const session = await prisma.session.findUnique({ where: { refreshTokenHash: tokenHash } });

  const invalid = new AppError(401, 'invalid_token', 'refresh token invalid');

  if (!session) throw invalid;
  if (session.revokedAt) throw invalid;
  if (session.expiresAt < new Date()) throw invalid;

  if (session.usedAt) {
    // Replay — possible theft. Revoke all sessions for this user.
    await prisma.session.updateMany({
      where: { userId: session.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await audit({ event: 'token.replay_detected', userId: session.userId, ...ctx });
    throw invalid;
  }

  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user || user.status !== 'ACTIVE') throw invalid;

  const result = await issueSession({
    userId: user.id,
    email: user.email,
    emailVerified: !!user.emailVerifiedAt,
    roles: user.roles,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  });

  await prisma.session.update({
    where: { id: session.id },
    data: { usedAt: new Date(), replacedById: result.sessionId, lastUsedAt: new Date() },
  });

  await audit({ event: 'token.refresh', userId: user.id, ...ctx });
  return result;
}

export async function revokeSessionByToken(refreshTokenPlain: string): Promise<void> {
  const tokenHash = hashToken(refreshTokenPlain);
  await prisma.session.updateMany({
    where: { refreshTokenHash: tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeSessionById(sessionId: string, userId: string): Promise<void> {
  // Scoped to userId so a caller can only revoke their own sessions.
  await prisma.session.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function listSessions(userId: string) {
  return prisma.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      ip: true,
      userAgent: true,
      createdAt: true,
      lastUsedAt: true,
      expiresAt: true,
    },
  });
}
