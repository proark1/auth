import type { Role } from '@prisma/client';
import { prisma } from '../infra/db.js';
import { generateToken, hashToken } from '../crypto/tokens.js';
import { issueAccessToken } from '../crypto/signing.js';
import { env } from '../infra/env.js';
import { audit } from '../infra/audit.js';
import { AppError } from '../middleware/errors.js';
import { notifyIfNewDevice } from './newDevice.js';

export interface IssueSessionInput {
  userId: string;
  email: string;
  emailVerified: boolean;
  role: Role;
  ip?: string | undefined;
  userAgent?: string | undefined;
  // Fire the "new device" notification email on this session if it's a fresh
  // login. Refresh-token rotations set this to false — we don't want to spam
  // the user every 15 minutes when they're already signed in. Default true.
  notifyOnNewDevice?: boolean | undefined;
  // Audit/email metadata: 'password' | 'magic_link' | 'passkey' | etc.
  // Drives only the new-device email's "method" field today.
  loggedInVia?: string | undefined;
  registeredClientId?: string | null | undefined;
}

function rolesClaim(role: Role): string[] {
  return role === 'ADMIN' ? ['admin'] : [];
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
    roles: rolesClaim(input.role),
  });

  // Fresh login (not a rotation) and the caller didn't suppress notifications
  // → check whether this device looks new, and email the user if so. Runs
  // best-effort; failures don't block the session issuance.
  if (input.notifyOnNewDevice !== false) {
    await notifyIfNewDevice({
      userId: input.userId,
      email: input.email,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      excludeSessionId: session.id,
      registeredClientId: input.registeredClientId ?? null,
      loggedInVia: input.loggedInVia,
    });
  }

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
    role: user.role,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    // Refresh-rotation isn't a fresh login; skip the new-device email so we
    // don't spam the user on every 15-minute rotation.
    notifyOnNewDevice: false,
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
