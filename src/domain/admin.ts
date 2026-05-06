import { Prisma } from '@prisma/client';
import { prisma } from '../infra/db.js';
import { audit } from '../infra/audit.js';
import { AppError } from '../middleware/errors.js';
import { ADMIN_ROLE } from '../middleware/auth.js';

// Admin-side operations on user accounts. Every mutation emits an audit event
// with both the actor (the calling admin) and the target user, so a /audit
// search by either id surfaces the change.

interface AdminCtx {
  actorId: string;       // admin user id from the JWT sub claim
  ip?: string | undefined;
  userAgent?: string | undefined;
}

// ---------- list / search ----------

export interface ListUsersInput {
  email?: string | undefined;        // case-insensitive substring match
  status?: 'PENDING' | 'ACTIVE' | 'DISABLED' | 'LOCKED' | undefined;
  role?: string | undefined;         // matches if the user has this role
  limit?: number | undefined;        // default 50, max 200
  offset?: number | undefined;
}

export interface AdminUserSummary {
  id: string;
  email: string;
  status: string;
  emailVerified: boolean;
  roles: string[];
  failedLoginCount: number;
  lockedUntil: string | null;
  createdAt: string;
}

export interface AdminUserListPage {
  users: AdminUserSummary[];
  total: number;
  limit: number;
  offset: number;
}

export async function listUsers(input: ListUsersInput): Promise<AdminUserListPage> {
  const limit = Math.min(input.limit ?? 50, 200);
  const offset = Math.max(input.offset ?? 0, 0);

  const where: Prisma.UserWhereInput = {};
  // Citext column makes this case-insensitive at the DB layer.
  if (input.email) where.email = { contains: input.email };
  if (input.status) where.status = input.status;
  if (input.role) where.roles = { has: input.role };

  const [rows, total] = await prisma.$transaction([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
      select: {
        id: true,
        email: true,
        status: true,
        emailVerifiedAt: true,
        roles: true,
        failedLoginCount: true,
        lockedUntil: true,
        createdAt: true,
      },
    }),
    prisma.user.count({ where }),
  ]);

  return {
    users: rows.map((u) => ({
      id: u.id,
      email: u.email,
      status: u.status,
      emailVerified: !!u.emailVerifiedAt,
      roles: u.roles,
      failedLoginCount: u.failedLoginCount,
      lockedUntil: u.lockedUntil ? u.lockedUntil.toISOString() : null,
      createdAt: u.createdAt.toISOString(),
    })),
    total,
    limit,
    offset,
  };
}

// ---------- detail ----------

export interface AdminUserDetail extends AdminUserSummary {
  registeredClientId: string | null;
  mfaFactors: Array<{
    id: string;
    type: string;
    label: string | null;
    confirmedAt: string | null;
    lastUsedAt: string | null;
  }>;
  activeSessionCount: number;
}

export async function getUserDetail(userId: string): Promise<AdminUserDetail> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      mfaFactors: {
        select: {
          id: true,
          type: true,
          label: true,
          confirmedAt: true,
          lastUsedAt: true,
        },
        orderBy: { createdAt: 'desc' },
      },
    },
  });
  if (!u) throw new AppError(404, 'not_found', 'user not found');

  const activeSessionCount = await prisma.session.count({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
  });

  return {
    id: u.id,
    email: u.email,
    status: u.status,
    emailVerified: !!u.emailVerifiedAt,
    roles: u.roles,
    failedLoginCount: u.failedLoginCount,
    lockedUntil: u.lockedUntil ? u.lockedUntil.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
    registeredClientId: u.registeredClientId,
    mfaFactors: u.mfaFactors.map((f) => ({
      id: f.id,
      type: f.type,
      label: f.label,
      confirmedAt: f.confirmedAt ? f.confirmedAt.toISOString() : null,
      lastUsedAt: f.lastUsedAt ? f.lastUsedAt.toISOString() : null,
    })),
    activeSessionCount,
  };
}

// ---------- update (status / roles) ----------

export interface UpdateUserInput {
  status?: 'ACTIVE' | 'DISABLED' | undefined;
  roles?: string[] | undefined;
}

export async function updateUser(
  userId: string,
  input: UpdateUserInput,
  ctx: AdminCtx,
): Promise<void> {
  if (input.status === undefined && input.roles === undefined) return;

  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) throw new AppError(404, 'not_found', 'user not found');

  // Refuse to let an admin demote themself out of the admin role — at least
  // one path back in must exist. Sister admins can still demote each other.
  if (
    input.roles !== undefined &&
    ctx.actorId === userId &&
    target.roles.includes(ADMIN_ROLE) &&
    !input.roles.includes(ADMIN_ROLE)
  ) {
    throw new AppError(
      400,
      'self_demote_blocked',
      'an admin cannot remove their own admin role; ask another admin',
    );
  }

  const data: Prisma.UserUpdateInput = {};
  if (input.status !== undefined) data.status = input.status;
  if (input.roles !== undefined) data.roles = input.roles;

  // Atomic: status flip and session revoke must both apply or neither. If
  // session.updateMany failed after the user.update committed, we'd leave
  // a "DISABLED but still has live refresh tokens" state — exactly the
  // window the security guarantee is meant to close.
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data });

    if (input.status === 'DISABLED') {
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
  });

  await audit({
    event: 'admin.user.updated',
    userId, // target
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: { actorId: ctx.actorId, ...input },
  });
}

// ---------- revoke all sessions ----------

export async function revokeAllSessions(userId: string, ctx: AdminCtx): Promise<number> {
  const result = await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await audit({
    event: 'admin.user.sessions.revoke_all',
    userId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
    metadata: { actorId: ctx.actorId, revokedCount: result.count },
  });
  return result.count;
}

// ---------- audit log ----------

export interface AuditLogQuery {
  limit?: number | undefined;
  before?: Date | undefined;          // pagination cursor (createdAt)
}

export async function getUserAuditLog(userId: string, query: AuditLogQuery = {}) {
  const limit = Math.min(query.limit ?? 50, 200);
  return prisma.auditEvent.findMany({
    where: {
      userId,
      ...(query.before ? { createdAt: { lt: query.before } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      event: true,
      ip: true,
      userAgent: true,
      metadata: true,
      createdAt: true,
    },
  });
}
