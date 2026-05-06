# auth-service

API-first authentication service for internal platform (HR, email, meeting bot, ...).

## Stack
- Node 22 + TypeScript, Fastify
- Postgres + Prisma, Redis
- Argon2id (passwords), `jose` (JWT/JWKS), `otplib` (TOTP), `@simplewebauthn/server` (passkeys, phase 2)

## Token model
- **Access token**: short-lived JWT (15 min), signed with rotating key, verified by other services via `/.well-known/jwks.json`. Stateless.
- **Refresh token**: opaque, stored hashed in `Session`, rotated on every use, revocable.
- **Service-to-service**: separate flow (TBD — client credentials).

## MVP scope
1. Register / verify email / resend verification
<<<<<<< HEAD
2. Login (password) + TOTP MFA + recovery (backup) codes
=======
2. Login (password or magic link) + TOTP MFA
>>>>>>> d9ca133 (Add magic-link (passwordless) login)
3. Refresh token rotation, logout, session list/revoke
4. Password forgot / reset / change
5. JWKS endpoint + key rotation
6. Audit log on every auth event
7. Rate limiting on all public endpoints

## Out of scope for MVP
- OAuth2 authorization server (third-party apps) — add Ory Hydra later if needed
- SSO / SAML / SCIM
- Passkeys (schema is ready, flow is phase 2)
- Social login

## Repo layout
```
prisma/schema.prisma   # DB model
src/server.ts          # Fastify bootstrap (API)
src/routes/            # HTTP layer
src/domain/            # business logic
src/infra/             # db, redis, email client
src/crypto/            # argon2, jwt, key rotation
web/                   # Next.js landing + login/register UI (deployed to Vercel)
```

The repo is a monorepo with two independently-deployed pieces:

- **API** at the root (`src/`, `prisma/`): Fastify on Node 22, deployed to
  Railway via `Dockerfile` + `railway.toml`. Lives at `auth.<your-domain>`.
- **Web** under `web/`: Next.js 15 App Router, deployed to Vercel with
  **Root Directory = `web`**. Lives at the apex (`<your-domain>`). Calls the
  API server-side via Next.js Route Handlers, so the refresh token never
  reaches the browser.

The two share nothing at runtime — `web/` only knows about the API via
`AUTH_API_URL` and the committed OpenAPI spec.

## API docs

The service is described by an OpenAPI 3.1 spec generated from the live Zod
schemas, so the docs cannot drift from the implementation.

- **Walkthrough:** [`docs/usage.md`](docs/usage.md) — end-to-end `curl`
  examples for every flow (register, login, MFA, refresh, password reset,
  service-to-service tokens, sessions).
- **Interactive UI:** `GET /docs` — Swagger UI, lists every endpoint with
  request/response schemas and a "Try it out" form.
- **Raw spec (live):** `GET /docs/json` — OpenAPI 3.1 JSON.
- **Raw spec (committed):** [`openapi.json`](openapi.json) — committed to the
  repo and verified up-to-date in CI. Feed it to `openapi-typescript`,
  `openapi-generator`, etc. without running the service.
- **Regenerate:** `npm run openapi:dump` rewrites `./openapi.json`. Pass
  `-- --out=path/to/file.json` to override the location.
- **Discovery:** `GET /.well-known/jwks.json` and
  `GET /.well-known/openid-configuration` for JWT-verifying consumers.

There is intentionally no hand-written SDK — generate clients from the spec
when a second consumer needs one.

### MCP server

For AI agents, every endpoint is also exposed as an MCP tool:

```sh
AUTH_API_BASE_URL=https://auth.example.com npm run mcp
```

The MCP server reads `openapi.json` at startup, so its tool list always
matches the HTTP API. See [`docs/usage.md` § 9](docs/usage.md#9-mcp-server)
for Claude Desktop / Cursor wiring.

## Local dev
```
cp .env.example .env
docker compose up -d
npm install
npm run prisma:migrate
npm run dev
```

## Deployment (Railway)
- One Railway project, three components: `auth-service` (this repo, Dockerfile build), Postgres plugin, Redis plugin.
- `railway.toml` runs `prisma migrate deploy` before each deploy and healthchecks `/readyz` (verifies DB connectivity). `/healthz` is the simpler "process alive" liveness probe.
- Required env vars: `DATABASE_URL`, `REDIS_URL`, `APP_ENCRYPTION_KEY`, `JWT_ISSUER`, `JWT_AUDIENCE`, `WEB_BASE_URL`, `EMAIL_SERVICE_URL`, `EMAIL_SERVICE_TOKEN`.
- Signing private keys + `APP_ENCRYPTION_KEY` should be injected from a real secret store (Doppler / Infisical), not pasted into the Railway UI.
- Put Cloudflare in front and add WAF rate limits on `/v1/login`, `/v1/register`, `/v1/password/forgot`.
