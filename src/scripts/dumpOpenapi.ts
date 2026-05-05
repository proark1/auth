// Boots the Fastify app in-memory (no port binding) and writes the OpenAPI 3.1
// spec to ./openapi.json so it can be committed, published, or fed into client
// generators (openapi-typescript, openapi-generator, etc.).
//
// Usage:
//   npm run openapi:dump
//   npm run openapi:dump -- --out=docs/openapi.json

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// The spec generator only needs env vars to be parseable — values don't have
// to point at real infra. Fill anything missing with placeholders.
process.env.DATABASE_URL ??= 'postgresql://placeholder:placeholder@localhost:5432/placeholder';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32).toString('base64');
process.env.JWT_ISSUER ??= 'http://localhost:8080';
process.env.JWT_AUDIENCE ??= 'placeholder';
process.env.NODE_ENV ??= 'development';
process.env.LOG_LEVEL ??= 'silent';

const { buildServer } = await import('../server.js');

function parseOut(argv: string[]): string {
  for (const arg of argv) {
    if (arg.startsWith('--out=')) return arg.slice('--out='.length);
  }
  return 'openapi.json';
}

const outPath = resolve(process.cwd(), parseOut(process.argv.slice(2)));

const app = await buildServer();
await app.ready();
const spec = app.swagger();
await writeFile(outPath, JSON.stringify(spec, null, 2) + '\n');
await app.close();

// eslint-disable-next-line no-console
console.log(`wrote ${outPath} (${Object.keys(spec.paths ?? {}).length} paths)`);
