import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { ZodError } from 'zod';
import { registerRoutes } from './routes/index.js';
import { AppError } from './middleware/errors.js';

export async function buildServer() {
  // trustProxy: how many proxy hops to honor for X-Forwarded-* (rate-limit IP,
  // req.ip). Defaults to 1 (Cloudflare → Railway). `true` would let any caller
  // forge X-Forwarded-For and bypass the per-IP rate limit, so we never want
  // that in production. Override via TRUST_PROXY when fronted by more hops.
  const trustProxyEnv = process.env.TRUST_PROXY;
  const trustProxy: number | boolean =
    trustProxyEnv === undefined
      ? 1
      : /^\d+$/.test(trustProxyEnv)
        ? Number(trustProxyEnv)
        : trustProxyEnv === 'true';

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: (process.env.CORS_ALLOW_ORIGINS ?? '').split(',').filter(Boolean),
    credentials: true,
  });
  await app.register(rateLimit, {
    global: true,
    max: 60,
    timeWindow: '1 minute',
    // Swagger UI loads many static assets per page view; skip rate-limiting
    // for /docs so browsing the API reference doesn't burn the budget.
    skipOnError: false,
    allowList: (req) => req.url.startsWith('/docs'),
  });

  // Swagger spec is always built (used by `npm run openapi:dump` and the
  // committed openapi.json), but the interactive /docs UI is only mounted
  // outside production unless explicitly enabled via ENABLE_DOCS_UI=true.
  // Leaving an unauthenticated Swagger UI on a public auth endpoint is gratuitous
  // surface area for attackers to enumerate routes / payloads.
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Auth Service API',
        description:
          'Authentication, session, MFA, password, and service-to-service token endpoints.',
        version: '0.0.1',
      },
      servers: [{ url: process.env.PUBLIC_BASE_URL ?? 'http://localhost:8080' }],
      tags: [
        { name: 'discovery', description: 'Health, JWKS, OIDC discovery' },
        { name: 'registration', description: 'Account creation and email verification' },
        { name: 'auth', description: 'Login, logout, token refresh' },
        { name: 'password', description: 'Password reset and change' },
        { name: 'mfa', description: 'Multi-factor authentication (TOTP)' },
        { name: 'sessions', description: 'Active session management' },
        { name: 'oauth', description: 'OAuth2 service-to-service tokens' },
        { name: 'me', description: 'Current user' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  const docsUiEnabled =
    process.env.ENABLE_DOCS_UI === 'true' || process.env.NODE_ENV !== 'production';
  if (docsUiEnabled) {
    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list', deepLinking: true },
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ code: err.code, message: err.message });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ code: 'invalid_request', issues: err.issues });
    }
    const validation = (err as { validation?: unknown }).validation;
    if (validation) {
      return reply.code(400).send({ code: 'invalid_request', issues: validation });
    }
    reply.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ code: 'internal_error', message: 'internal error' });
  });

  await registerRoutes(app);
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8080);
  buildServer()
    .then((app) => app.listen({ port, host: '0.0.0.0' }))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
