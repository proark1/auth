import Fastify from 'fastify';
import { registerRoutes } from './routes/index.js';

export function buildServer() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true,
  });

  // TODO: register plugins
  //   - @fastify/helmet
  //   - @fastify/cors          (allowlist)
  //   - @fastify/rate-limit    (Redis store; tighter limits on /login, /register, /password/*)
  //   - fastify-type-provider-zod
  //   - audit-log plugin
  //   - prisma plugin

  registerRoutes(app);
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 8080);
  app.listen({ port, host: '0.0.0.0' }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
