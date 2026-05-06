import type {
  FastifyInstance,
  FastifyRequest,
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod/v4';
import { jwks } from '../crypto/signing.js';
import { env } from '../infra/env.js';
import { registerUser, verifyEmail, resendVerification } from '../domain/users.js';
import { login } from '../domain/login.js';
import { forgotPassword, resetPassword, changePassword } from '../domain/password.js';
import { setupTotp, confirmTotp, deleteTotp, completeMfaLogin } from '../domain/mfa.js';
import { issueClientCredentialsToken } from '../domain/services.js';
import {
  rotateSession,
  revokeSessionByToken,
  revokeSessionById,
  listSessions,
} from '../domain/sessions.js';
import { requireUser, currentUser, attachServiceIfPresent } from '../middleware/auth.js';
import { prisma } from '../infra/db.js';
import { AppError } from '../middleware/errors.js';

export type AppInstance = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;

// MVP route map.
// Conventions:
//   - All inputs validated with zod (fastify-type-provider-zod).
//   - All write endpoints emit an AuditEvent (handled in domain/).
//   - Public endpoints sit behind a stricter rate limit than authed ones.
//   - User-enumeration-sensitive endpoints (register, resend, password reset)
//     always return the same shape regardless of whether the email exists.

const PASSWORD_MIN_LENGTH = 12;

const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(256);

const emailSchema = z.string().email().max(254);

// Shared response schemas
const errorResponse = z.object({
  code: z.string(),
  message: z.string().optional(),
  issues: z.array(z.unknown()).optional(),
});

const tokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int(),
  refresh_token_expires_at: z.string().datetime(),
});

const mfaChallengeResponse = z.object({
  mfa_required: z.literal(true),
  mfa_token: z.string(),
});

const loginResponse = z.union([tokenResponse, mfaChallengeResponse]);

const noContentResponses = {
  204: z.null().describe('No content'),
  400: errorResponse,
  401: errorResponse,
};

const authedNoContentResponses = {
  ...noContentResponses,
};

function ctxFrom(req: FastifyRequest) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}

// Resolve ServiceClient.id (uuid PK) from the s2s token's client_id (string).
// Returns null if no service token attached or the client no longer exists.
async function resolveAttachedClientId(req: FastifyRequest): Promise<string | null> {
  if (!req.service) return null;
  const row = await prisma.serviceClient.findUnique({
    where: { clientId: req.service.clientId },
    select: { id: true },
  });
  return row?.id ?? null;
}

export async function registerRoutes(app: AppInstance) {
  const r = app;

  // Per-route rate limits. Public, sensitive endpoints get stricter caps to
  // blunt brute-force / enumeration. Discovery routes are uncapped (probed
  // by infra). Everything else inherits the global default (60/min/IP).
  const strict = { rateLimit: { max: 10, timeWindow: '1 minute' } };
  const veryStrict = { rateLimit: { max: 5, timeWindow: '1 minute' } };
  const uncapped = { rateLimit: false as const };

  // --- Public discovery ---
  r.route({
    method: 'GET',
    url: '/healthz',
    config: uncapped,
    schema: {
      tags: ['discovery'],
      summary: 'Liveness probe',
      response: {
        200: z.object({ ok: z.literal(true) }),
      },
    },
    handler: async () => ({ ok: true as const }),
  });

  // Readiness probe — distinct from liveness. /healthz only proves the
  // process is alive; /readyz proves the dependencies it needs to actually
  // serve traffic are reachable. Used by Railway / k8s readiness checks so
  // a fresh container isn't sent traffic before its DB pool warms.
  //
  // Currently checks Postgres only — Redis isn't wired into a runtime client
  // yet (REDIS_URL exists in env for forward compatibility). Add a Redis
  // ping here when the first feature actually depends on it.
  const readyResponse = z.object({
    ok: z.boolean(),
    checks: z.object({
      db: z.object({
        ok: z.boolean(),
        latency_ms: z.number().int().optional(),
        error: z.string().optional(),
      }),
    }),
  });
  r.route({
    method: 'GET',
    url: '/readyz',
    config: uncapped,
    schema: {
      tags: ['discovery'],
      summary: 'Readiness probe (verifies DB connectivity)',
      response: { 200: readyResponse, 503: readyResponse },
    },
    handler: async (_req, reply) => {
      const start = Date.now();
      let dbOk = false;
      let dbError: string | undefined;
      try {
        await prisma.$queryRaw`SELECT 1`;
        dbOk = true;
      } catch (err) {
        dbError = err instanceof Error ? err.message.slice(0, 200) : String(err);
      }
      const latencyMs = Date.now() - start;
      const status = dbOk ? 200 : 503;
      return reply.code(status).send({
        ok: dbOk,
        checks: {
          db: dbOk
            ? { ok: true, latency_ms: latencyMs }
            : { ok: false, latency_ms: latencyMs, error: dbError ?? 'unknown' },
        },
      });
    },
  });

  r.route({
    method: 'GET',
    url: '/.well-known/jwks.json',
    config: uncapped,
    schema: {
      tags: ['discovery'],
      summary: 'JWKS for verifying issued JWTs',
      response: {
        200: z.object({
          keys: z.array(z.looseObject({})),
        }),
      },
    },
    handler: async () => jwks() as unknown as { keys: Record<string, unknown>[] },
  });

  r.route({
    method: 'GET',
    url: '/.well-known/openid-configuration',
    config: uncapped,
    schema: {
      tags: ['discovery'],
      summary: 'OpenID Connect discovery document',
      response: {
        200: z.object({
          issuer: z.string(),
          jwks_uri: z.string(),
          id_token_signing_alg_values_supported: z.array(z.string()),
          response_types_supported: z.array(z.string()),
          subject_types_supported: z.array(z.string()),
        }),
      },
    },
    handler: async () => {
      const e = env();
      return {
        issuer: e.JWT_ISSUER,
        jwks_uri: `${e.JWT_ISSUER.replace(/\/$/, '')}/.well-known/jwks.json`,
        id_token_signing_alg_values_supported: ['EdDSA'],
        response_types_supported: ['token'],
        subject_types_supported: ['public'],
      };
    },
  });

  // --- Registration & email verification ---

  const registerBody = z.object({ email: emailSchema, password: passwordSchema });
  r.route({
    method: 'POST',
    url: '/v1/register',
    preHandler: [attachServiceIfPresent],
    config: strict,
    schema: {
      tags: ['registration'],
      summary: 'Register a new account',
      description:
        'Always returns 202 regardless of whether the email is already registered, to prevent enumeration. ' +
        'If called with a valid service-to-service access token, the user is associated with that service ' +
        'and verification/password emails will use the service\'s configured From address and subject.',
      body: registerBody,
      response: {
        202: z.object({ status: z.literal('pending_verification') }),
        400: errorResponse,
      },
    },
    handler: async (req, reply) => {
      const body = req.body as z.infer<typeof registerBody>;
      const registeredClientId = await resolveAttachedClientId(req);
      await registerUser({ ...body, registeredClientId }, ctxFrom(req));
      return reply.code(202).send({ status: 'pending_verification' as const });
    },
  });

  const verifyBody = z.object({ token: z.string().min(1).max(512) });
  r.route({
    method: 'POST',
    url: '/v1/email/verify',
    config: strict,
    schema: {
      tags: ['registration'],
      summary: 'Verify email with token',
      body: verifyBody,
      response: {
        200: z.object({ status: z.literal('verified') }),
        400: errorResponse,
      },
    },
    handler: async (req, reply) => {
      const { token } = req.body as z.infer<typeof verifyBody>;
      await verifyEmail(token, ctxFrom(req));
      return reply.code(200).send({ status: 'verified' as const });
    },
  });

  const resendBody = z.object({ email: emailSchema });
  r.route({
    method: 'POST',
    url: '/v1/email/verify/resend',
    config: strict,
    schema: {
      tags: ['registration'],
      summary: 'Resend verification email',
      description: 'Always returns 202 to prevent enumeration.',
      body: resendBody,
      response: {
        202: z.object({ status: z.literal('queued') }),
        400: errorResponse,
      },
    },
    handler: async (req, reply) => {
      const { email } = req.body as z.infer<typeof resendBody>;
      await resendVerification(email, ctxFrom(req));
      return reply.code(202).send({ status: 'queued' as const });
    },
  });

  // --- Login / token lifecycle ---

  // Login uses a looser password schema than register so we never leak the
  // register-side complexity rules via 400 vs 401 responses.
  const loginPasswordSchema = z.string().min(1).max(256);
  const loginBody = z.object({ email: emailSchema, password: loginPasswordSchema });
  r.route({
    method: 'POST',
    url: '/v1/login',
    config: veryStrict,
    schema: {
      tags: ['auth'],
      summary: 'Log in with email and password',
      description:
        'Returns either an access/refresh token pair, or an MFA challenge if a TOTP factor is enrolled.',
      body: loginBody,
      response: {
        200: loginResponse,
        400: errorResponse,
        401: errorResponse,
      },
    },
    handler: async (req, reply) => {
      const result = await login(req.body as z.infer<typeof loginBody>, ctxFrom(req));
      if (result.kind === 'mfa_required') {
        return reply.code(200).send({ mfa_required: true as const, mfa_token: result.mfaToken });
      }
      return reply.code(200).send(tokenPayload(result.session));
    },
  });

  const loginMfaBody = z.object({
    mfa_token: z.string().min(1).max(2048),
    code: z.string().regex(/^\d{6}$/),
  });
  r.route({
    method: 'POST',
    url: '/v1/login/mfa',
    config: veryStrict,
    schema: {
      tags: ['auth', 'mfa'],
      summary: 'Complete login with TOTP code',
      body: loginMfaBody,
      response: {
        200: tokenResponse,
        400: errorResponse,
        401: errorResponse,
      },
    },
    handler: async (req, reply) => {
      const { mfa_token, code } = req.body as z.infer<typeof loginMfaBody>;
      const session = await completeMfaLogin({
        mfaToken: mfa_token,
        code,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      return reply.code(200).send(tokenPayload(session));
    },
  });

  const refreshBody = z.object({ refresh_token: z.string().min(1).max(512) });
  r.route({
    method: 'POST',
    url: '/v1/token/refresh',
    config: strict,
    schema: {
      tags: ['auth'],
      summary: 'Rotate refresh token, get a new access/refresh pair',
      body: refreshBody,
      response: {
        200: tokenResponse,
        400: errorResponse,
        401: errorResponse,
      },
    },
    handler: async (req, reply) => {
      const { refresh_token } = req.body as z.infer<typeof refreshBody>;
      const result = await rotateSession(refresh_token, ctxFrom(req));
      return reply.code(200).send(tokenPayload(result));
    },
  });

  const logoutBody = z.object({ refresh_token: z.string().min(1).max(512).optional() });
  r.route({
    method: 'POST',
    url: '/v1/logout',
    preHandler: [requireUser],
    schema: {
      tags: ['auth'],
      summary: 'Log out (revoke refresh token)',
      security: [{ bearerAuth: [] }],
      body: logoutBody,
      response: authedNoContentResponses,
    },
    handler: async (req, reply) => {
      const body = req.body as z.infer<typeof logoutBody>;
      if (body.refresh_token) {
        await revokeSessionByToken(body.refresh_token);
      }
      return reply.code(204).send(null);
    },
  });

  // --- Password ---

  const forgotBody = z.object({ email: emailSchema });
  r.route({
    method: 'POST',
    url: '/v1/password/forgot',
    config: veryStrict,
    schema: {
      tags: ['password'],
      summary: 'Request a password reset link',
      description: 'Always returns 202 to prevent enumeration.',
      body: forgotBody,
      response: {
        202: z.object({ status: z.literal('queued') }),
        400: errorResponse,
      },
    },
    handler: async (req, reply) => {
      const { email } = req.body as z.infer<typeof forgotBody>;
      await forgotPassword(email, ctxFrom(req));
      return reply.code(202).send({ status: 'queued' as const });
    },
  });

  const resetBody = z.object({
    token: z.string().min(1).max(512),
    new_password: passwordSchema,
  });
  r.route({
    method: 'POST',
    url: '/v1/password/reset',
    config: strict,
    schema: {
      tags: ['password'],
      summary: 'Reset password using a reset token',
      body: resetBody,
      response: {
        200: z.object({ status: z.literal('reset') }),
        400: errorResponse,
      },
    },
    handler: async (req, reply) => {
      const { token, new_password } = req.body as z.infer<typeof resetBody>;
      await resetPassword(token, new_password, ctxFrom(req));
      return reply.code(200).send({ status: 'reset' as const });
    },
  });

  const changeBody = z.object({
    current_password: z.string().min(1).max(256),
    new_password: passwordSchema,
  });
  r.route({
    method: 'POST',
    url: '/v1/password/change',
    preHandler: [requireUser],
    schema: {
      tags: ['password'],
      summary: 'Change password (authenticated)',
      security: [{ bearerAuth: [] }],
      body: changeBody,
      response: authedNoContentResponses,
    },
    handler: async (req, reply) => {
      const me = currentUser(req);
      const { current_password, new_password } = req.body as z.infer<typeof changeBody>;
      await changePassword(me.id, current_password, new_password, ctxFrom(req));
      return reply.code(204).send(null);
    },
  });

  // --- Current user ---
  const meResponse = z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    email_verified: z.boolean(),
    status: z.string(),
    created_at: z.string().datetime(),
  });
  r.route({
    method: 'GET',
    url: '/v1/me',
    preHandler: [requireUser],
    schema: {
      tags: ['me'],
      summary: 'Current authenticated user',
      security: [{ bearerAuth: [] }],
      response: {
        200: meResponse,
        401: errorResponse,
        404: errorResponse,
      },
    },
    handler: async (req) => {
      const me = currentUser(req);
      const u = await prisma.user.findUnique({ where: { id: me.id } });
      if (!u) throw new AppError(404, 'not_found', 'user not found');
      return {
        id: u.id,
        email: u.email,
        email_verified: !!u.emailVerifiedAt,
        status: u.status,
        created_at: u.createdAt.toISOString(),
      };
    },
  });

  // --- MFA (TOTP) ---

  const totpSetupBody = z.object({ label: z.string().max(100).optional() });
  r.route({
    method: 'POST',
    url: '/v1/mfa/totp/setup',
    preHandler: [requireUser],
    schema: {
      tags: ['mfa'],
      summary: 'Begin TOTP enrollment (returns secret + otpauth URI)',
      security: [{ bearerAuth: [] }],
      body: totpSetupBody,
      response: {
        200: z.object({
          factor_id: z.string().uuid(),
          secret: z.string(),
          otpauth_uri: z.string(),
        }),
        401: errorResponse,
      },
    },
    handler: async (req) => {
      const me = currentUser(req);
      const { label } = req.body as z.infer<typeof totpSetupBody>;
      const result = await setupTotp(me.id, label, ctxFrom(req));
      return {
        factor_id: result.factorId,
        secret: result.secret,
        otpauth_uri: result.otpauthUri,
      };
    },
  });

  const totpConfirmBody = z.object({
    factor_id: z.string().uuid(),
    code: z.string().regex(/^\d{6}$/),
  });
  r.route({
    method: 'POST',
    url: '/v1/mfa/totp/confirm',
    preHandler: [requireUser],
    schema: {
      tags: ['mfa'],
      summary: 'Confirm TOTP enrollment with first code',
      security: [{ bearerAuth: [] }],
      body: totpConfirmBody,
      response: authedNoContentResponses,
    },
    handler: async (req, reply) => {
      const me = currentUser(req);
      const { factor_id, code } = req.body as z.infer<typeof totpConfirmBody>;
      await confirmTotp(me.id, factor_id, code, ctxFrom(req));
      return reply.code(204).send(null);
    },
  });

  const totpDeleteParams = z.object({ id: z.string().uuid() });
  r.route({
    method: 'DELETE',
    url: '/v1/mfa/totp/:id',
    preHandler: [requireUser],
    schema: {
      tags: ['mfa'],
      summary: 'Remove a TOTP factor',
      security: [{ bearerAuth: [] }],
      params: totpDeleteParams,
      response: authedNoContentResponses,
    },
    handler: async (req, reply) => {
      const me = currentUser(req);
      const { id } = req.params as z.infer<typeof totpDeleteParams>;
      await deleteTotp(me.id, id, ctxFrom(req));
      return reply.code(204).send(null);
    },
  });

  // --- Service-to-service token (OAuth2 client_credentials) ---

  const oauthTokenBody = z.object({
    grant_type: z.literal('client_credentials'),
    client_id: z.string().min(1).max(64),
    client_secret: z.string().min(1).max(512),
    scope: z.string().max(512).optional(), // space-separated, optional narrowing
  });
  const oauthTokenResponse = z.object({
    access_token: z.string(),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int(),
    scope: z.string(),
  });
  r.route({
    method: 'POST',
    url: '/v1/oauth/token',
    config: strict,
    schema: {
      tags: ['oauth'],
      summary: 'OAuth2 client_credentials token endpoint',
      body: oauthTokenBody,
      response: {
        200: oauthTokenResponse,
        400: errorResponse,
        401: errorResponse,
      },
    },
    handler: async (req, reply) => {
      const body = req.body as z.infer<typeof oauthTokenBody>;
      const requestedScopes = body.scope ? body.scope.split(' ').filter(Boolean) : undefined;
      const result = await issueClientCredentialsToken(
        {
          clientId: body.client_id,
          clientSecret: body.client_secret,
          ...(requestedScopes ? { requestedScopes } : {}),
        },
        ctxFrom(req),
      );
      return reply.code(200).send({
        access_token: result.accessToken,
        token_type: 'Bearer' as const,
        expires_in: result.expiresIn,
        scope: result.scopes.join(' '),
      });
    },
  });

  // --- Sessions ---
  const sessionItem = z.object({
    id: z.string().uuid(),
    createdAt: z.string().datetime().or(z.date()),
    lastUsedAt: z.string().datetime().or(z.date()).nullable().optional(),
    ip: z.string().nullable().optional(),
    userAgent: z.string().nullable().optional(),
  });
  r.route({
    method: 'GET',
    url: '/v1/sessions',
    preHandler: [requireUser],
    schema: {
      tags: ['sessions'],
      summary: 'List active sessions for current user',
      security: [{ bearerAuth: [] }],
      response: {
        200: z.array(sessionItem),
        401: errorResponse,
      },
    },
    handler: async (req) => {
      const me = currentUser(req);
      return listSessions(me.id);
    },
  });

  const sessionParams = z.object({ id: z.string().uuid() });
  r.route({
    method: 'DELETE',
    url: '/v1/sessions/:id',
    preHandler: [requireUser],
    schema: {
      tags: ['sessions'],
      summary: 'Revoke a session by id',
      security: [{ bearerAuth: [] }],
      params: sessionParams,
      response: authedNoContentResponses,
    },
    handler: async (req, reply) => {
      const me = currentUser(req);
      const { id } = req.params as z.infer<typeof sessionParams>;
      await revokeSessionById(id, me.id);
      return reply.code(204).send(null);
    },
  });
}

interface IssuedTokenLike {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

function tokenPayload(s: IssuedTokenLike) {
  return {
    access_token: s.accessToken,
    refresh_token: s.refreshToken,
    token_type: 'Bearer' as const,
    expires_in: env().ACCESS_TOKEN_TTL_SECONDS,
    refresh_token_expires_at: s.refreshTokenExpiresAt.toISOString(),
  };
}
