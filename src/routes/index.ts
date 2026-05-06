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
import {
  setupTotp,
  confirmTotp,
  deleteTotp,
  completeMfaLogin,
  completeMfaLoginWithBackupCode,
} from '../domain/mfa.js';
import { regenerateBackupCodes, countUnusedBackupCodes } from '../domain/backupCodes.js';
import { requestEmailChange, confirmEmailChange } from '../domain/emailChange.js';
import { requestMagicLink, verifyMagicLink } from '../domain/magicLink.js';
import {
  startPasskeyRegistration,
  verifyPasskeyRegistration,
  deletePasskey,
  listPasskeys,
  startPasskeyLogin,
  verifyPasskeyLogin,
} from '../domain/passkeys.js';
import { issueClientCredentialsToken } from '../domain/services.js';
import {
  requestAccountDeletion,
  confirmAccountDeletion,
  exportUserData,
} from '../domain/account.js';
import {
  rotateSession,
  revokeSessionByToken,
  revokeSessionById,
  listSessions,
} from '../domain/sessions.js';
import { requireUser, currentUser, attachServiceIfPresent } from '../middleware/auth.js';
import { prisma } from '../infra/db.js';
import { AppError } from '../middleware/errors.js';
import { registerAdminRoutes } from './admin.js';

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
        // Always populated for both success and failure — handler measures
        // wall time around the probe call. Non-negative by construction.
        latency_ms: z.number().int().min(0),
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
        // Truncate regardless of source — non-Error throws (`throw "boom"`)
        // shouldn't sneak past the cap on response-body size.
        dbError = (err instanceof Error ? err.message : String(err)).slice(0, 200);
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

  // Recovery path: complete MFA login with a printed backup code instead of
  // a TOTP. Same rate limit + lockout as TOTP failures so this can't be used
  // as an easier brute-force surface.
  const loginRecoveryBody = z.object({
    mfa_token: z.string().min(1).max(2048),
    backup_code: z.string().min(8).max(32),
  });
  r.route({
    method: 'POST',
    url: '/v1/login/mfa/recovery',
    config: veryStrict,
    schema: {
      tags: ['auth', 'mfa'],
      summary: 'Complete login with an MFA backup (recovery) code',
      body: loginRecoveryBody,
      response: {
        200: tokenResponse,
        400: errorResponse,
        401: errorResponse,
      },
    },
    handler: async (req, reply) => {
      const { mfa_token, backup_code } = req.body as z.infer<typeof loginRecoveryBody>;
      const session = await completeMfaLoginWithBackupCode({
        mfaToken: mfa_token,
        backupCode: backup_code,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      return reply.code(200).send(tokenPayload(session));
    },
  });

  // Magic-link login (passwordless). Two endpoints, mirrors the
  // forgot/reset-password shape:
  //   - request: always returns 202; sends a one-shot URL by email if the
  //     account exists, is ACTIVE, and email-verified.
  //   - verify:  exchanges the URL token for either a session or, if MFA is
  //     enrolled, the same mfa_token shape /v1/login returns. Single-use,
  //     atomic claim, 15-minute TTL.
  const magicRequestBody = z.object({ email: emailSchema });
  r.route({
    method: 'POST',
    url: '/v1/login/magic/request',
    config: veryStrict,
    schema: {
      tags: ['auth'],
      summary: 'Request a one-shot magic-link sign-in email',
      description: 'Always returns 202 to prevent enumeration.',
      body: magicRequestBody,
      response: {
        202: z.object({ status: z.literal('queued') }),
        400: errorResponse,
      },
    },
    handler: async (req, reply) => {
      const { email } = req.body as z.infer<typeof magicRequestBody>;
      await requestMagicLink(email, ctxFrom(req));
      return reply.code(202).send({ status: 'queued' as const });
    },
  });

  const magicVerifyBody = z.object({ token: z.string().min(1).max(512) });
  r.route({
    method: 'POST',
    url: '/v1/login/magic/verify',
    config: veryStrict,
    schema: {
      tags: ['auth'],
      summary: 'Exchange a magic-link token for a session (or MFA challenge)',
      body: magicVerifyBody,
      response: {
        200: loginResponse,
        400: errorResponse,
      },
    },
    handler: async (req, reply) => {
      const { token } = req.body as z.infer<typeof magicVerifyBody>;
      const result = await verifyMagicLink(token, ctxFrom(req));
      if (result.kind === 'mfa_required') {
        return reply.code(200).send({ mfa_required: true as const, mfa_token: result.mfaToken });
      }
      return reply.code(200).send(tokenPayload(result.session));
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

  // --- Email change (authenticated) ---
  // Request goes via current password + new address; the confirm token is
  // emailed to the NEW address as proof of ownership. Confirming swaps the
  // email and revokes every active session.

  const emailChangeRequestBody = z.object({
    current_password: z.string().min(1).max(256),
    new_email: emailSchema,
  });
  r.route({
    method: 'POST',
    url: '/v1/email/change/request',
    preHandler: [requireUser],
    config: strict,
    schema: {
      tags: ['registration'],
      summary: 'Request an email-address change (sends confirm link to new address)',
      security: [{ bearerAuth: [] }],
      body: emailChangeRequestBody,
      response: {
        202: z.object({ status: z.literal('queued') }),
        400: errorResponse,
        401: errorResponse,
        409: errorResponse,
      },
    },
    handler: async (req, reply) => {
      const me = currentUser(req);
      const body = req.body as z.infer<typeof emailChangeRequestBody>;
      await requestEmailChange(
        { userId: me.id, currentPassword: body.current_password, newEmail: body.new_email },
        ctxFrom(req),
      );
      return reply.code(202).send({ status: 'queued' as const });
    },
  });

  const emailChangeConfirmBody = z.object({ token: z.string().min(1).max(512) });
  r.route({
    method: 'POST',
    url: '/v1/email/change/confirm',
    config: strict,
    schema: {
      tags: ['registration'],
      summary: 'Confirm an email-address change with the emailed token',
      description:
        'Single-use, 1-hour TTL. On success the user is logged out of every device — '
        + "the new email is the new recovery path, so re-authentication is forced.",
      body: emailChangeConfirmBody,
      response: {
        200: z.object({ status: z.literal('changed'), email: z.string().email() }),
        400: errorResponse,
        409: errorResponse,
      },
    },
    handler: async (req, reply) => {
      const { token } = req.body as z.infer<typeof emailChangeConfirmBody>;
      const result = await confirmEmailChange(token, ctxFrom(req));
      return reply.code(200).send({ status: 'changed' as const, email: result.newEmail });
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

  // GDPR data export. Returns the entirety of what we hold for the caller as
  // a single JSON blob — secrets are never included in plaintext (TOTP
  // secret bytes, refresh-token hashes, password hash all elided), but every
  // visible attribute, every session, every audit event, every token row is.
  r.route({
    method: 'GET',
    url: '/v1/me/data',
    preHandler: [requireUser],
    schema: {
      tags: ['me'],
      summary: 'Export everything we hold about the current user (JSON)',
      security: [{ bearerAuth: [] }],
      // The shape is large and pretty-much all-optional in practice; surface
      // it as `unknown` rather than re-declaring the export schema in two
      // places. The OpenAPI is still useful as a discovery endpoint.
      response: { 200: z.unknown(), 401: errorResponse, 404: errorResponse },
    },
    handler: async (req, reply) => {
      const me = currentUser(req);
      const data = await exportUserData(me.id);
      // application/json is the default; set Content-Disposition so a curl
      // -O actually saves a file with a sensible name.
      reply.header('content-disposition', `attachment; filename="auth-export-${me.id}.json"`);
      return data;
    },
  });

  // Self-service account deletion. Two-step: re-auth + emailed confirm token,
  // then hard delete on confirm. Mirrors password-reset / email-change.
  const deleteRequestBody = z.object({ current_password: z.string().min(1).max(256) });
  r.route({
    method: 'POST',
    url: '/v1/me/delete/request',
    preHandler: [requireUser],
    config: strict,
    schema: {
      tags: ['me'],
      summary: 'Request account deletion (sends confirm link)',
      security: [{ bearerAuth: [] }],
      body: deleteRequestBody,
      response: {
        202: z.object({ status: z.literal('queued') }),
        400: errorResponse,
        401: errorResponse,
      },
    },
    handler: async (req, reply) => {
      const me = currentUser(req);
      const body = req.body as z.infer<typeof deleteRequestBody>;
      await requestAccountDeletion(me.id, body.current_password, ctxFrom(req));
      return reply.code(202).send({ status: 'queued' as const });
    },
  });

  const deleteConfirmBody = z.object({ token: z.string().min(1).max(512) });
  r.route({
    method: 'POST',
    url: '/v1/me/delete/confirm',
    config: strict,
    schema: {
      tags: ['me'],
      summary: 'Confirm account deletion with the emailed token (irreversible)',
      description:
        'Hard-deletes the user. Cascades drop sessions, MFA factors, and pending '
        + 'tokens. Audit events stay in the log with userId nulled.',
      body: deleteConfirmBody,
      response: {
        200: z.object({ status: z.literal('deleted') }),
        400: errorResponse,
      },
    },
    handler: async (req, reply) => {
      const { token } = req.body as z.infer<typeof deleteConfirmBody>;
      await confirmAccountDeletion(token, ctxFrom(req));
      return reply.code(200).send({ status: 'deleted' as const });
    },
  });

  // --- MFA (TOTP) ---

  const mfaFactorItem = z.object({
    id: z.string().uuid(),
    type: z.enum(['TOTP', 'WEBAUTHN']),
    label: z.string().nullable(),
    confirmedAt: z.string().datetime().nullable(),
    lastUsedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  });
  r.route({
    method: 'GET',
    url: '/v1/mfa',
    preHandler: [requireUser],
    schema: {
      tags: ['mfa'],
      summary: 'List the current user\'s MFA factors',
      security: [{ bearerAuth: [] }],
      response: {
        200: z.object({ factors: z.array(mfaFactorItem) }),
        401: errorResponse,
      },
    },
    handler: async (req) => {
      const me = currentUser(req);
      const rows = await prisma.mfaFactor.findMany({
        where: { userId: me.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          type: true,
          label: true,
          confirmedAt: true,
          lastUsedAt: true,
          createdAt: true,
        },
      });
      return {
        factors: rows.map((f) => ({
          id: f.id,
          type: f.type,
          label: f.label,
          confirmedAt: f.confirmedAt ? f.confirmedAt.toISOString() : null,
          lastUsedAt: f.lastUsedAt ? f.lastUsedAt.toISOString() : null,
          createdAt: f.createdAt.toISOString(),
        })),
      };
    },
  });

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

  // Backup codes: regenerate (returns plaintext once) + read remaining count.
  // Regenerating discards any prior batch atomically, so a leaked old set
  // becomes useless the moment the user prints a new one.
  const backupCodesResponse = z.object({
    codes: z.array(z.string()),
    count: z.number().int(),
  });
  r.route({
    method: 'POST',
    url: '/v1/mfa/backup-codes/regenerate',
    preHandler: [requireUser],
    schema: {
      tags: ['mfa'],
      summary: 'Generate a fresh batch of MFA backup codes',
      description:
        'Returns plaintext codes exactly once. Any previously-issued codes are invalidated. ' +
        'Display these to the user and tell them to store them somewhere safe.',
      security: [{ bearerAuth: [] }],
      response: {
        200: backupCodesResponse,
        401: errorResponse,
        404: errorResponse,
      },
    },
    handler: async (req) => {
      const me = currentUser(req);
      const codes = await regenerateBackupCodes(me.id, ctxFrom(req));
      return { codes, count: codes.length };
    },
  });

  r.route({
    method: 'GET',
    url: '/v1/mfa/backup-codes',
    preHandler: [requireUser],
    schema: {
      tags: ['mfa'],
      summary: 'Number of unused MFA backup codes remaining',
      security: [{ bearerAuth: [] }],
      response: {
        200: z.object({ remaining: z.number().int() }),
        401: errorResponse,
      },
    },
    handler: async (req) => {
      const me = currentUser(req);
      const remaining = await countUnusedBackupCodes(me.id);
      return { remaining };
    },
  });

  // --- Passkeys (WebAuthn) ---
  //
  // The challenge_token returned by the */start endpoints is a server-signed
  // JWT carrying the random WebAuthn challenge. The client passes it back
  // unchanged on /verify; we never trust the client's reported challenge.
  //
  // The WebAuthn response objects are large and provider-shaped. We don't
  // model them with strict zod — simplewebauthn is the source of truth and
  // rejects malformed input. The route schema caps overall body size via
  // Fastify's bodyLimit defaults to keep payloads reasonable.

  const passkeyRegisterStartBody = z.object({}).optional();
  const passkeyOptionsResponse = z.object({
    options: z.unknown(),
    challenge_token: z.string(),
  });
  r.route({
    method: 'POST',
    url: '/v1/mfa/passkey/register/start',
    preHandler: [requireUser],
    schema: {
      tags: ['mfa'],
      summary: 'Begin passkey enrollment (returns WebAuthn creation options)',
      security: [{ bearerAuth: [] }],
      body: passkeyRegisterStartBody,
      response: { 200: passkeyOptionsResponse, 401: errorResponse },
    },
    handler: async (req) => {
      const me = currentUser(req);
      const result = await startPasskeyRegistration(me.id, ctxFrom(req));
      return { options: result.options, challenge_token: result.challengeToken };
    },
  });

  const passkeyRegisterVerifyBody = z.object({
    challenge_token: z.string().min(1).max(2048),
    response: z.unknown(), // RegistrationResponseJSON, validated by simplewebauthn
    label: z.string().max(100).optional(),
  });
  r.route({
    method: 'POST',
    url: '/v1/mfa/passkey/register/verify',
    preHandler: [requireUser],
    schema: {
      tags: ['mfa'],
      summary: 'Confirm passkey enrollment with the authenticator response',
      security: [{ bearerAuth: [] }],
      body: passkeyRegisterVerifyBody,
      response: {
        200: z.object({ factor_id: z.string().uuid() }),
        400: errorResponse,
        401: errorResponse,
      },
    },
    handler: async (req) => {
      const me = currentUser(req);
      const body = req.body as z.infer<typeof passkeyRegisterVerifyBody>;
      const result = await verifyPasskeyRegistration(
        {
          userId: me.id,
          challengeToken: body.challenge_token,
          response: body.response as Parameters<typeof verifyPasskeyRegistration>[0]['response'],
          label: body.label,
        },
        ctxFrom(req),
      );
      return { factor_id: result.factorId };
    },
  });

  const passkeyItem = z.object({
    id: z.string().uuid(),
    label: z.string().nullable(),
    aaguid: z.string().nullable(),
    transports: z.array(z.string()),
    createdAt: z.string().datetime().or(z.date()),
    lastUsedAt: z.string().datetime().or(z.date()).nullable(),
  });
  r.route({
    method: 'GET',
    url: '/v1/mfa/passkeys',
    preHandler: [requireUser],
    schema: {
      tags: ['mfa'],
      summary: "List the current user's passkeys",
      security: [{ bearerAuth: [] }],
      response: { 200: z.array(passkeyItem), 401: errorResponse },
    },
    handler: async (req) => {
      const me = currentUser(req);
      return listPasskeys(me.id);
    },
  });

  const passkeyDeleteParams = z.object({ id: z.string().uuid() });
  r.route({
    method: 'DELETE',
    url: '/v1/mfa/passkey/:id',
    preHandler: [requireUser],
    schema: {
      tags: ['mfa'],
      summary: 'Remove a passkey',
      security: [{ bearerAuth: [] }],
      params: passkeyDeleteParams,
      response: authedNoContentResponses,
    },
    handler: async (req, reply) => {
      const me = currentUser(req);
      const { id } = req.params as z.infer<typeof passkeyDeleteParams>;
      await deletePasskey(me.id, id, ctxFrom(req));
      return reply.code(204).send(null);
    },
  });

  // Login via passkey: replaces password+MFA with a single signed assertion.
  // Public + veryStrict rate-limited like the password login.
  r.route({
    method: 'POST',
    url: '/v1/login/passkey/start',
    config: veryStrict,
    schema: {
      tags: ['auth'],
      summary: 'Begin passkey login (returns WebAuthn request options)',
      response: { 200: passkeyOptionsResponse },
    },
    handler: async () => {
      const result = await startPasskeyLogin();
      return { options: result.options, challenge_token: result.challengeToken };
    },
  });

  const passkeyLoginVerifyBody = z.object({
    challenge_token: z.string().min(1).max(2048),
    response: z.unknown(), // AuthenticationResponseJSON, validated by simplewebauthn
  });
  r.route({
    method: 'POST',
    url: '/v1/login/passkey',
    config: veryStrict,
    schema: {
      tags: ['auth'],
      summary: 'Complete passkey login and receive a session',
      body: passkeyLoginVerifyBody,
      response: { 200: tokenResponse, 400: errorResponse, 401: errorResponse },
    },
    handler: async (req, reply) => {
      const body = req.body as z.infer<typeof passkeyLoginVerifyBody>;
      const session = await verifyPasskeyLogin({
        challengeToken: body.challenge_token,
        response: body.response as Parameters<typeof verifyPasskeyLogin>[0]['response'],
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      return reply.code(200).send(tokenPayload(session));
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

  await registerAdminRoutes(r);
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
