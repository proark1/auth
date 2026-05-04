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

  // --- Login / logout / token lifecycle ---  (slice 3)
  r.post('/v1/login', async () => { throw new Error('TODO'); });
  r.post('/v1/login/mfa', async () => { throw new Error('TODO'); });
  r.post('/v1/token/refresh', async () => { throw new Error('TODO'); });
  r.post('/v1/logout', { preHandler: [requireUser] }, async () => { throw new Error('TODO'); });

  // --- Password ---  (slice 4)
  r.post('/v1/password/forgot', async () => { throw new Error('TODO'); });
  r.post('/v1/password/reset', async () => { throw new Error('TODO'); });
  r.post('/v1/password/change', { preHandler: [requireUser] }, async () => { throw new Error('TODO'); });

  // --- Current user ---
  r.get('/v1/me', { preHandler: [requireUser] }, async () => { throw new Error('TODO'); });

  // --- MFA (TOTP) ---  (slice 5)
  r.post('/v1/mfa/totp/setup', { preHandler: [requireUser] }, async () => { throw new Error('TODO'); });
  r.post('/v1/mfa/totp/confirm', { preHandler: [requireUser] }, async () => { throw new Error('TODO'); });
  r.delete('/v1/mfa/totp/:id', { preHandler: [requireUser] }, async () => { throw new Error('TODO'); });

  // --- Sessions ---
  r.get('/v1/sessions', { preHandler: [requireUser] }, async () => { throw new Error('TODO'); });
  r.delete('/v1/sessions/:id', { preHandler: [requireUser] }, async () => { throw new Error('TODO'); });
}

async function requireUser() {
  // Verify Authorization: Bearer <jwt>, attach req.user — implemented in slice 3.
  throw new Error('TODO');
}
