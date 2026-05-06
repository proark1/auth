import { z } from 'zod/v4';
import type { FastifyRequest } from 'fastify';
import { requireAdmin, currentUser } from '../middleware/auth.js';
import {
  getStats,
  listUsers,
  getUserDetail,
  updateUser,
  revokeAllSessionsForUser,
  listAuditEvents,
  listClients,
  getClient,
  updateClient,
  rotateClientSecret,
  listSigningKeys,
  rotateKey,
} from '../domain/admin.js';
import { createServiceClient } from '../domain/services.js';
import type { AppInstance } from './index.js';

// Admin endpoints. Mounted under /v1/admin. Every route runs requireAdmin,
// which 401s on a missing/invalid token and 403s on a non-admin user.

const userStatusEnum = z.enum(['PENDING', 'ACTIVE', 'DISABLED', 'LOCKED']);
const roleEnum = z.enum(['USER', 'ADMIN']);

const errorResponse = z.object({
  code: z.string(),
  message: z.string().optional(),
  issues: z.array(z.unknown()).optional(),
});

const adminResponses = {
  401: errorResponse,
  403: errorResponse,
};

function ctxFor(req: FastifyRequest) {
  const me = currentUser(req);
  return { actorUserId: me.id, ip: req.ip, userAgent: req.headers['user-agent'] };
}

export async function registerAdminRoutes(app: AppInstance) {
  const r = app;

  // --- stats ---
  r.route({
    method: 'GET',
    url: '/v1/admin/stats',
    preHandler: [requireAdmin],
    schema: {
      tags: ['admin'],
      summary: 'Operational counters for the admin overview',
      security: [{ bearerAuth: [] }],
      response: {
        200: z.object({
          users: z.object({
            total: z.number().int(),
            active: z.number().int(),
            pending: z.number().int(),
            disabled: z.number().int(),
            locked: z.number().int(),
            admins: z.number().int(),
          }),
          sessions: z.object({ active: z.number().int() }),
          signups7d: z.number().int(),
          logins7d: z.number().int(),
          failedLogins24h: z.number().int(),
        }),
        ...adminResponses,
      },
    },
    handler: async () => getStats(),
  });

  // --- users list ---
  const listUsersQuery = z.object({
    query: z.string().max(200).optional(),
    status: userStatusEnum.optional(),
    role: roleEnum.optional(),
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  });
  const userListItem = z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    status: userStatusEnum,
    role: roleEnum,
    emailVerified: z.boolean(),
    createdAt: z.string().datetime(),
  });
  r.route({
    method: 'GET',
    url: '/v1/admin/users',
    preHandler: [requireAdmin],
    schema: {
      tags: ['admin'],
      summary: 'List users (keyset paginated)',
      security: [{ bearerAuth: [] }],
      querystring: listUsersQuery,
      response: {
        200: z.object({
          users: z.array(userListItem),
          nextCursor: z.string().uuid().nullable(),
        }),
        ...adminResponses,
      },
    },
    handler: async (req) => {
      const q = req.query as z.infer<typeof listUsersQuery>;
      return listUsers(q);
    },
  });

  // --- user detail ---
  const userIdParams = z.object({ id: z.string().uuid() });
  r.route({
    method: 'GET',
    url: '/v1/admin/users/:id',
    preHandler: [requireAdmin],
    schema: {
      tags: ['admin'],
      summary: 'Get a user with session/MFA counts and recent audit events',
      security: [{ bearerAuth: [] }],
      params: userIdParams,
      response: {
        200: z.object({
          id: z.string().uuid(),
          email: z.string().email(),
          status: userStatusEnum,
          role: roleEnum,
          emailVerified: z.boolean(),
          createdAt: z.string().datetime(),
          registeredClient: z
            .object({ id: z.string().uuid(), name: z.string() })
            .nullable(),
          sessionCount: z.number().int(),
          mfaFactorCount: z.number().int(),
          recentEvents: z.array(
            z.object({
              id: z.string().uuid(),
              event: z.string(),
              ip: z.string().nullable(),
              userAgent: z.string().nullable(),
              createdAt: z.string().datetime(),
            }),
          ),
        }),
        404: errorResponse,
        ...adminResponses,
      },
    },
    handler: async (req) => {
      const { id } = req.params as z.infer<typeof userIdParams>;
      return getUserDetail(id);
    },
  });

  // --- patch user (status / role) ---
  const patchUserBody = z.object({
    status: userStatusEnum.optional(),
    role: roleEnum.optional(),
  });
  r.route({
    method: 'PATCH',
    url: '/v1/admin/users/:id',
    preHandler: [requireAdmin],
    schema: {
      tags: ['admin'],
      summary: 'Update a user\'s status or role',
      security: [{ bearerAuth: [] }],
      params: userIdParams,
      body: patchUserBody,
      response: {
        204: z.null().describe('No content'),
        400: errorResponse,
        404: errorResponse,
        ...adminResponses,
      },
    },
    handler: async (req, reply) => {
      const { id } = req.params as z.infer<typeof userIdParams>;
      const patch = req.body as z.infer<typeof patchUserBody>;
      await updateUser(id, patch, ctxFor(req));
      return reply.code(204).send(null);
    },
  });

  // --- revoke all sessions for a user ---
  r.route({
    method: 'POST',
    url: '/v1/admin/users/:id/sessions/revoke',
    preHandler: [requireAdmin],
    schema: {
      tags: ['admin'],
      summary: 'Revoke all active sessions for a user',
      security: [{ bearerAuth: [] }],
      params: userIdParams,
      response: {
        204: z.null().describe('No content'),
        ...adminResponses,
      },
    },
    handler: async (req, reply) => {
      const { id } = req.params as z.infer<typeof userIdParams>;
      await revokeAllSessionsForUser(id, ctxFor(req));
      return reply.code(204).send(null);
    },
  });

  // --- audit log ---
  const listAuditQuery = z.object({
    userId: z.string().uuid().optional(),
    event: z.string().max(200).optional(),
    since: z.coerce.date().optional(),
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  });
  r.route({
    method: 'GET',
    url: '/v1/admin/audit',
    preHandler: [requireAdmin],
    schema: {
      tags: ['admin'],
      summary: 'Audit events (keyset paginated)',
      security: [{ bearerAuth: [] }],
      querystring: listAuditQuery,
      response: {
        200: z.object({
          events: z.array(
            z.object({
              id: z.string().uuid(),
              userId: z.string().uuid().nullable(),
              event: z.string(),
              ip: z.string().nullable(),
              userAgent: z.string().nullable(),
              metadata: z.unknown().nullable(),
              createdAt: z.string().datetime(),
            }),
          ),
          nextCursor: z.string().uuid().nullable(),
        }),
        ...adminResponses,
      },
    },
    handler: async (req) => {
      const q = req.query as z.infer<typeof listAuditQuery>;
      return listAuditEvents(q);
    },
  });

  // --- service clients ---
  const clientItem = z.object({
    id: z.string().uuid(),
    clientId: z.string(),
    name: z.string(),
    scopes: z.array(z.string()),
    disabled: z.boolean(),
    fromAddress: z.string().nullable(),
    verifyEmailSubject: z.string().nullable(),
    passwordResetSubject: z.string().nullable(),
    createdAt: z.string().datetime(),
    lastUsedAt: z.string().datetime().nullable(),
  });
  r.route({
    method: 'GET',
    url: '/v1/admin/clients',
    preHandler: [requireAdmin],
    schema: {
      tags: ['admin'],
      summary: 'List all service clients (no secrets)',
      security: [{ bearerAuth: [] }],
      response: { 200: z.array(clientItem), ...adminResponses },
    },
    handler: async () => listClients(),
  });

  r.route({
    method: 'GET',
    url: '/v1/admin/clients/:id',
    preHandler: [requireAdmin],
    schema: {
      tags: ['admin'],
      summary: 'Get a service client by id',
      security: [{ bearerAuth: [] }],
      params: userIdParams,
      response: { 200: clientItem, 404: errorResponse, ...adminResponses },
    },
    handler: async (req) => {
      const { id } = req.params as z.infer<typeof userIdParams>;
      return getClient(id);
    },
  });

  const createClientBody = z.object({
    name: z.string().min(1).max(200),
    scopes: z.array(z.string().max(100)).max(50).optional(),
    fromAddress: z.string().email().optional(),
    verifyEmailSubject: z.string().max(200).optional(),
    passwordResetSubject: z.string().max(200).optional(),
  });
  r.route({
    method: 'POST',
    url: '/v1/admin/clients',
    preHandler: [requireAdmin],
    schema: {
      tags: ['admin'],
      summary: 'Create a service client (returns plaintext secret once)',
      security: [{ bearerAuth: [] }],
      body: createClientBody,
      response: {
        201: z.object({
          id: z.string().uuid(),
          clientId: z.string(),
          clientSecret: z.string(),
          name: z.string(),
          scopes: z.array(z.string()),
          fromAddress: z.string().nullable(),
          verifyEmailSubject: z.string().nullable(),
          passwordResetSubject: z.string().nullable(),
        }),
        400: errorResponse,
        ...adminResponses,
      },
    },
    handler: async (req, reply) => {
      const body = req.body as z.infer<typeof createClientBody>;
      const created = await createServiceClient(body);
      return reply.code(201).send({
        id: created.id,
        clientId: created.clientId,
        clientSecret: created.clientSecret,
        name: created.name,
        scopes: created.scopes,
        fromAddress: created.fromAddress,
        verifyEmailSubject: created.verifyEmailSubject,
        passwordResetSubject: created.passwordResetSubject,
      });
    },
  });

  const patchClientBody = z.object({
    name: z.string().min(1).max(200).optional(),
    scopes: z.array(z.string().max(100)).max(50).optional(),
    disabled: z.boolean().optional(),
    fromAddress: z.string().email().nullable().optional(),
    verifyEmailSubject: z.string().max(200).nullable().optional(),
    passwordResetSubject: z.string().max(200).nullable().optional(),
  });
  r.route({
    method: 'PATCH',
    url: '/v1/admin/clients/:id',
    preHandler: [requireAdmin],
    schema: {
      tags: ['admin'],
      summary: 'Update a service client (name, scopes, branding, disabled)',
      security: [{ bearerAuth: [] }],
      params: userIdParams,
      body: patchClientBody,
      response: { 204: z.null().describe('No content'), 404: errorResponse, ...adminResponses },
    },
    handler: async (req, reply) => {
      const { id } = req.params as z.infer<typeof userIdParams>;
      const patch = req.body as z.infer<typeof patchClientBody>;
      await updateClient(id, patch, ctxFor(req));
      return reply.code(204).send(null);
    },
  });

  r.route({
    method: 'POST',
    url: '/v1/admin/clients/:id/rotate-secret',
    preHandler: [requireAdmin],
    schema: {
      tags: ['admin'],
      summary: 'Rotate a service client\'s secret (returns new secret once)',
      security: [{ bearerAuth: [] }],
      params: userIdParams,
      response: {
        200: z.object({ clientSecret: z.string() }),
        404: errorResponse,
        ...adminResponses,
      },
    },
    handler: async (req) => {
      const { id } = req.params as z.infer<typeof userIdParams>;
      return rotateClientSecret(id, ctxFor(req));
    },
  });

  // --- signing keys ---
  r.route({
    method: 'GET',
    url: '/v1/admin/keys',
    preHandler: [requireAdmin],
    schema: {
      tags: ['admin'],
      summary: 'List JWT signing keys',
      security: [{ bearerAuth: [] }],
      response: {
        200: z.array(
          z.object({
            id: z.string().uuid(),
            kid: z.string(),
            alg: z.string(),
            status: z.enum(['ACTIVE', 'RETIRING', 'RETIRED']),
            createdAt: z.string().datetime(),
            retiredAt: z.string().datetime().nullable(),
          }),
        ),
        ...adminResponses,
      },
    },
    handler: async () => listSigningKeys(),
  });

  r.route({
    method: 'POST',
    url: '/v1/admin/keys/rotate',
    preHandler: [requireAdmin],
    schema: {
      tags: ['admin'],
      summary: 'Generate a new signing key and demote previous ACTIVE to RETIRING',
      security: [{ bearerAuth: [] }],
      response: {
        200: z.object({ kid: z.string() }),
        ...adminResponses,
      },
    },
    handler: async (req) => rotateKey(ctxFor(req)),
  });
}
