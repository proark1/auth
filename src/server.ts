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
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: (process.env.CORS_ALLOW_ORIGINS ?? '').split(',').filter(Boolean),
    credentials: true,
  });
  await app.register(rateLimit, {
    global: false,
    max: 60,
    timeWindow: '1 minute',
  });

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

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

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
