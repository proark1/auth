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
2. Login (password) + TOTP MFA
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
src/server.ts          # Fastify bootstrap
src/routes/            # HTTP layer
src/domain/            # business logic (TBD)
src/infra/             # db, redis, email client (TBD)
src/crypto/            # argon2, jwt, key rotation (TBD)
```

## Local dev
```
cp .env.example .env
docker compose up -d postgres redis   # TBD
npm install
npm run prisma:migrate
npm run dev
```
