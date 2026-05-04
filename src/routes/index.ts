import type {
  FastifyInstance,
  FastifyRequest,
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
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
import { requireUser, currentUser } from '../middleware/auth.js';
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

function ctxFrom(req: FastifyRequest) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}

export async function registerRoutes(app: AppInstance) {
  const r = app;

  // --- Public discovery ---
  r.get('/healthz', async () => ({ ok: true }));
  r.get('/.well-known/jwks.json', async () => jwks());
  r.get('/.well-known/openid-configuration', async () => {
    const e = env();
    return {
      issuer: e.JWT_ISSUER,
      jwks_uri: `${e.JWT_ISSUER.replace(/\/$/, '')}/.well-known/jwks.json`,
      id_token_signing_alg_values_supported: ['EdDSA'],
      response_types_supported: ['token'],
      subject_types_supported: ['public'],
    };
  });

  // --- Registration & email verification ---

  const registerBody = z.object({ email: emailSchema, password: passwordSchema });
  r.route({
    method: 'POST',
    url: '/v1/register',
    schema: { body: registerBody },
    handler: async (req, reply) => {
      await registerUser(req.body as z.infer<typeof registerBody>, ctxFrom(req));
      // Always 202 — caller cannot infer whether email was new.
      return reply.code(202).send({ status: 'pending_verification' });
    },
  });

  const verifyBody = z.object({ token: z.string().min(1).max(512) });
  r.route({
    method: 'POST',
    url: '/v1/email/verify',
    schema: { body: verifyBody },
    handler: async (req, reply) => {
      const { token } = req.body as z.infer<typeof verifyBody>;
      await verifyEmail(token, ctxFrom(req));
      return reply.code(200).send({ status: 'verified' });
    },
  });

  const resendBody = z.object({ email: emailSchema });
  r.route({
    method: 'POST',
    url: '/v1/email/verify/resend',
    schema: { body: resendBody },
    handler: async (req, reply) => {
      const { email } = req.body as z.infer<typeof resendBody>;
      await resendVerification(email, ctxFrom(req));
      return reply.code(202).send({ status: 'queued' });
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
    schema: { body: loginBody },
    handler: async (req, reply) => {
      const result = await login(req.body as z.infer<typeof loginBody>, ctxFrom(req));
      if (result.kind === 'mfa_required') {
        return reply.code(200).send({ mfa_required: true, mfa_token: result.mfaToken });
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
    schema: { body: loginMfaBody },
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
    schema: { body: refreshBody },
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
    schema: { body: logoutBody },
    handler: async (req, reply) => {
      const body = req.body as z.infer<typeof logoutBody>;
      if (body.refresh_token) {
        await revokeSessionByToken(body.refresh_token);
      }
      return reply.code(204).send();
    },
  });

  // --- Password ---

  const forgotBody = z.object({ email: emailSchema });
  r.route({
    method: 'POST',
    url: '/v1/password/forgot',
    schema: { body: forgotBody },
    handler: async (req, reply) => {
      const { email } = req.body as z.infer<typeof forgotBody>;
      await forgotPassword(email, ctxFrom(req));
      // Always 202 — no enumeration.
      return reply.code(202).send({ status: 'queued' });
    },
  });

  const resetBody = z.object({
    token: z.string().min(1).max(512),
    new_password: passwordSchema,
  });
  r.route({
    method: 'POST',
    url: '/v1/password/reset',
    schema: { body: resetBody },
    handler: async (req, reply) => {
      const { token, new_password } = req.body as z.infer<typeof resetBody>;
      await resetPassword(token, new_password, ctxFrom(req));
      return reply.code(200).send({ status: 'reset' });
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
    schema: { body: changeBody },
    handler: async (req, reply) => {
      const me = currentUser(req);
      const { current_password, new_password } = req.body as z.infer<typeof changeBody>;
      await changePassword(me.id, current_password, new_password, ctxFrom(req));
      return reply.code(204).send();
    },
  });

  // --- Current user ---
  r.route({
    method: 'GET',
    url: '/v1/me',
    preHandler: [requireUser],
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
    schema: { body: totpSetupBody },
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
    schema: { body: totpConfirmBody },
    handler: async (req, reply) => {
      const me = currentUser(req);
      const { factor_id, code } = req.body as z.infer<typeof totpConfirmBody>;
      await confirmTotp(me.id, factor_id, code, ctxFrom(req));
      return reply.code(204).send();
    },
  });

  const totpDeleteParams = z.object({ id: z.string().uuid() });
  r.route({
    method: 'DELETE',
    url: '/v1/mfa/totp/:id',
    preHandler: [requireUser],
    schema: { params: totpDeleteParams },
    handler: async (req, reply) => {
      const me = currentUser(req);
      const { id } = req.params as z.infer<typeof totpDeleteParams>;
      await deleteTotp(me.id, id, ctxFrom(req));
      return reply.code(204).send();
    },
  });

  // --- Service-to-service token (OAuth2 client_credentials) ---

  const oauthTokenBody = z.object({
    grant_type: z.literal('client_credentials'),
    client_id: z.string().min(1).max(64),
    client_secret: z.string().min(1).max(512),
    scope: z.string().max(512).optional(), // space-separated, optional narrowing
  });
  r.route({
    method: 'POST',
    url: '/v1/oauth/token',
    schema: { body: oauthTokenBody },
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
        token_type: 'Bearer',
        expires_in: result.expiresIn,
        scope: result.scopes.join(' '),
      });
    },
  });

  // --- Sessions ---
  r.route({
    method: 'GET',
    url: '/v1/sessions',
    preHandler: [requireUser],
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
    schema: { params: sessionParams },
    handler: async (req, reply) => {
      const me = currentUser(req);
      const { id } = req.params as z.infer<typeof sessionParams>;
      await revokeSessionById(id, me.id);
      return reply.code(204).send();
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
    token_type: 'Bearer',
    expires_in: env().ACCESS_TOKEN_TTL_SECONDS,
    refresh_token_expires_at: s.refreshTokenExpiresAt.toISOString(),
  };
}
