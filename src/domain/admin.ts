import { randomBytes } from 'node:crypto';
import type { Prisma, Role, UserStatus } from '@prisma/client';
import { prisma } from '../infra/db.js';
import { audit } from '../infra/audit.js';
import { hashPassword } from '../crypto/password.js';
import { rotateSigningKey } from '../crypto/signing.js';
import { AppError } from '../middleware/errors.js';

interface ActorCtx {
  actorUserId: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

// ---------- stats ----------

export async function getStats() {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 3600 * 1000);

  const [total, active, pending, disabled, locked, admins, sessionsActive, signups7d, logins7d, failedLogins24h] =
    await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { status: 'ACTIVE' } }),
      prisma.user.count({ where: { status: 'PENDING' } }),
      prisma.user.count({ where: { status: 'DISABLED' } }),
      prisma.user.count({ where: { status: 'LOCKED' } }),
      prisma.user.count({ where: { role: 'ADMIN' } }),
      prisma.session.count({ where: { revokedAt: null, expiresAt: { gt: now } } }),
      prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      prisma.auditEvent.count({ where: { event: 'login.success', createdAt: { gte: sevenDaysAgo } } }),
      prisma.auditEvent.count({
        where: { event: { startsWith: 'login.fail' }, createdAt: { gte: oneDayAgo } },
      }),
    ]);

  return {
    users: { total, active, pending, disabled, locked, admins },
    sessions: { active: sessionsActive },
    signups7d,
    logins7d,
    failedLogins24h,
  };
}

// ---------- users ----------

export interface ListUsersFilters {
  query?: string | undefined;
  status?: UserStatus | undefined;
  role?: Role | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export async function listUsers(filters: ListUsersFilters) {
  const limit = Math.min(filters.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  const where: Prisma.UserWhereInput = {};
  if (filters.query) where.email = { contains: filters.query, mode: 'insensitive' };
  if (filters.status) where.status = filters.status;
  if (filters.role) where.role = filters.role;

  const rows = await prisma.user.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      email: true,
      status: true,
      role: true,
      emailVerifiedAt: true,
      createdAt: true,
    },
  });

  let nextCursor: string | null = null;
  if (rows.length > limit) {
    const last = rows.pop();
    nextCursor = last?.id ?? null;
  }

  return {
    users: rows.map((u) => ({
      id: u.id,
      email: u.email,
      status: u.status,
      role: u.role,
      emailVerified: !!u.emailVerifiedAt,
      createdAt: u.createdAt.toISOString(),
    })),
    nextCursor,
  };
}

export async function getUserDetail(id: string) {
  const user = await prisma.user.findUnique({
    where: { id },
    include: { registeredClient: { select: { id: true, name: true } } },
  });
  if (!user) throw new AppError(404, 'not_found', 'user not found');

  const [sessionCount, mfaFactorCount, recentEvents] = await Promise.all([
    prisma.session.count({ where: { userId: id, revokedAt: null, expiresAt: { gt: new Date() } } }),
    prisma.mfaFactor.count({ where: { userId: id, confirmedAt: { not: null } } }),
    prisma.auditEvent.findMany({
      where: { userId: id },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, event: true, ip: true, userAgent: true, createdAt: true },
    }),
  ]);

  return {
    id: user.id,
    email: user.email,
    status: user.status,
    role: user.role,
    emailVerified: !!user.emailVerifiedAt,
    createdAt: user.createdAt.toISOString(),
    registeredClient: user.registeredClient
      ? { id: user.registeredClient.id, name: user.registeredClient.name }
      : null,
    sessionCount,
    mfaFactorCount,
    recentEvents: recentEvents.map((e) => ({
      id: e.id,
      event: e.event,
      ip: e.ip,
      userAgent: e.userAgent,
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

export interface UpdateUserInput {
  status?: UserStatus | undefined;
  role?: Role | undefined;
}

export async function updateUser(
  id: string,
  patch: UpdateUserInput,
  ctx: ActorCtx,
): Promise<void> {
  if (patch.status === undefined && patch.role === undefined) return;

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) throw new AppError(404, 'not_found', 'user not found');

  if (patch.role !== undefined && patch.role !== target.role) {
    if (id === ctx.actorUserId && target.role === 'ADMIN' && patch.role === 'USER') {
      throw new AppError(400, 'cannot_demote_self', 'admins cannot demote themselves');
    }
    if (target.role === 'ADMIN' && patch.role === 'USER') {
      const remainingAdmins = await prisma.user.count({
        where: { role: 'ADMIN', id: { not: id } },
      });
      if (remainingAdmins === 0) {
        throw new AppError(400, 'last_admin', 'cannot demote the last admin');
      }
    }
  }

  const data: Prisma.UserUpdateInput = {};
  const diff: Record<string, { from: string; to: string }> = {};
  if (patch.status !== undefined && patch.status !== target.status) {
    data.status = patch.status;
    diff.status = { from: target.status, to: patch.status };
  }
  if (patch.role !== undefined && patch.role !== target.role) {
    data.role = patch.role;
    diff.role = { from: target.role, to: patch.role };
  }
  if (Object.keys(diff).length === 0) return;

  await prisma.user.update({ where: { id }, data });

  // Role change: revoke active sessions so the new role takes effect immediately
  // (otherwise admins would remain admin until their access token expires).
  if (diff.role) {
    await prisma.session.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  await audit({
    event: 'admin.user.updated',
    userId: id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: { actorUserId: ctx.actorUserId, diff },
  });
}

export async function revokeAllSessionsForUser(id: string, ctx: ActorCtx): Promise<void> {
  await prisma.session.updateMany({
    where: { userId: id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await audit({
    event: 'admin.user.sessions_revoked',
    userId: id,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: { actorUserId: ctx.actorUserId },
  });
}

// ---------- audit ----------

export interface ListAuditFilters {
  userId?: string | undefined;
  event?: string | undefined;
  since?: Date | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export async function listAuditEvents(filters: ListAuditFilters) {
  const limit = Math.min(filters.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  const where: Prisma.AuditEventWhereInput = {};
  if (filters.userId) where.userId = filters.userId;
  if (filters.event) where.event = { contains: filters.event };
  if (filters.since) where.createdAt = { gte: filters.since };

  const rows = await prisma.auditEvent.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      userId: true,
      event: true,
      ip: true,
      userAgent: true,
      metadata: true,
      createdAt: true,
    },
  });

  let nextCursor: string | null = null;
  if (rows.length > limit) {
    const last = rows.pop();
    nextCursor = last?.id ?? null;
  }

  return {
    events: rows.map((e) => ({
      id: e.id,
      userId: e.userId,
      event: e.event,
      ip: e.ip,
      userAgent: e.userAgent,
      metadata: e.metadata,
      createdAt: e.createdAt.toISOString(),
    })),
    nextCursor,
  };
}

// ---------- service clients ----------

export async function listClients() {
  const rows = await prisma.serviceClient.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      clientId: true,
      name: true,
      scopes: true,
      disabled: true,
      fromAddress: true,
      verifyEmailSubject: true,
      passwordResetSubject: true,
      audience: true,
      webBaseUrl: true,
      createdAt: true,
      lastUsedAt: true,
    },
  });
  return rows.map((c) => ({
    id: c.id,
    clientId: c.clientId,
    name: c.name,
    scopes: c.scopes,
    disabled: c.disabled,
    fromAddress: c.fromAddress,
    verifyEmailSubject: c.verifyEmailSubject,
    passwordResetSubject: c.passwordResetSubject,
    audience: c.audience,
    webBaseUrl: c.webBaseUrl,
    createdAt: c.createdAt.toISOString(),
    lastUsedAt: c.lastUsedAt ? c.lastUsedAt.toISOString() : null,
  }));
}

export async function getClient(id: string) {
  const c = await prisma.serviceClient.findUnique({ where: { id } });
  if (!c) throw new AppError(404, 'not_found', 'client not found');
  return {
    id: c.id,
    clientId: c.clientId,
    name: c.name,
    scopes: c.scopes,
    disabled: c.disabled,
    fromAddress: c.fromAddress,
    verifyEmailSubject: c.verifyEmailSubject,
    passwordResetSubject: c.passwordResetSubject,
    audience: c.audience,
    webBaseUrl: c.webBaseUrl,
    createdAt: c.createdAt.toISOString(),
    lastUsedAt: c.lastUsedAt ? c.lastUsedAt.toISOString() : null,
  };
}

export interface UpdateClientInput {
  name?: string | undefined;
  scopes?: string[] | undefined;
  disabled?: boolean | undefined;
  fromAddress?: string | null | undefined;
  verifyEmailSubject?: string | null | undefined;
  passwordResetSubject?: string | null | undefined;
  audience?: string | null | undefined;
  webBaseUrl?: string | null | undefined;
}

export async function updateClient(id: string, patch: UpdateClientInput, ctx: ActorCtx) {
  const existing = await prisma.serviceClient.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'not_found', 'client not found');

  const data: Prisma.ServiceClientUpdateInput = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.scopes !== undefined) data.scopes = patch.scopes;
  if (patch.disabled !== undefined) data.disabled = patch.disabled;
  if (patch.fromAddress !== undefined) data.fromAddress = patch.fromAddress;
  if (patch.verifyEmailSubject !== undefined) data.verifyEmailSubject = patch.verifyEmailSubject;
  if (patch.passwordResetSubject !== undefined) data.passwordResetSubject = patch.passwordResetSubject;
  if (patch.audience !== undefined) data.audience = patch.audience;
  if (patch.webBaseUrl !== undefined) data.webBaseUrl = patch.webBaseUrl;

  await prisma.serviceClient.update({ where: { id }, data });

  await audit({
    event: 'admin.client.updated',
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: { actorUserId: ctx.actorUserId, clientId: existing.clientId, patch },
  });
}

export async function rotateClientSecret(id: string, ctx: ActorCtx): Promise<{ clientSecret: string }> {
  const existing = await prisma.serviceClient.findUnique({ where: { id } });
  if (!existing) throw new AppError(404, 'not_found', 'client not found');

  const clientSecret = randomBytes(32).toString('base64url');
  await prisma.serviceClient.update({
    where: { id },
    data: { clientSecretHash: await hashPassword(clientSecret) },
  });

  await audit({
    event: 'admin.client.secret_rotated',
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: { actorUserId: ctx.actorUserId, clientId: existing.clientId },
  });

  return { clientSecret };
}

// ---------- signing keys ----------

export async function listSigningKeys() {
  const rows = await prisma.signingKey.findMany({
    orderBy: { createdAt: 'desc' },
    select: { id: true, kid: true, alg: true, status: true, createdAt: true, retiredAt: true },
  });
  return rows.map((k) => ({
    id: k.id,
    kid: k.kid,
    alg: k.alg,
    status: k.status,
    createdAt: k.createdAt.toISOString(),
    retiredAt: k.retiredAt ? k.retiredAt.toISOString() : null,
  }));
}

export async function rotateKey(ctx: ActorCtx): Promise<{ kid: string }> {
  const fresh = await rotateSigningKey();
  await audit({
    event: 'admin.key.rotated',
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: { actorUserId: ctx.actorUserId, kid: fresh.kid },
  });
  return { kid: fresh.kid };
}
