# Auth Service — usage guide

This walks through every supported flow with concrete `curl` commands. The
canonical reference is the OpenAPI spec (`openapi.json`, served at
`/docs/json`) and the interactive Swagger UI at `/docs`.

All endpoints are versioned under `/v1`. Tokens, sessions, and MFA are
described in `README.md`; this doc is the "how do I actually call it" view.

Replace `$BASE` with your deployment URL (e.g. `https://auth.example.com`).

```sh
BASE=https://auth.example.com
```

---

## 1. End-user account flow

### Register

```sh
curl -sS -X POST $BASE/v1/register \
  -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"correct horse battery staple"}'
# → 202 {"status":"pending_verification"}
```

The endpoint always returns 202, even if the email already exists, to prevent
enumeration. The user receives a verification email out of band.

### Verify email

```sh
curl -sS -X POST $BASE/v1/email/verify \
  -H 'content-type: application/json' \
  -d '{"token":"<token-from-email>"}'
# → 200 {"status":"verified"}
```

### Resend verification

```sh
curl -sS -X POST $BASE/v1/email/verify/resend \
  -H 'content-type: application/json' \
  -d '{"email":"alice@example.com"}'
# → 202 {"status":"queued"}
```

### Log in (no MFA enrolled)

```sh
curl -sS -X POST $BASE/v1/login \
  -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"correct horse battery staple"}'
# → 200
# {
#   "access_token":"eyJ…",       // JWT, ~15 min TTL
#   "refresh_token":"opaque…",    // store securely, single-use
#   "token_type":"Bearer",
#   "expires_in":900,
#   "refresh_token_expires_at":"2026-05-12T10:00:00.000Z"
# }
```

### Log in (with TOTP MFA enrolled)

```sh
# Step 1: same call as above, but response is a challenge.
curl -sS -X POST $BASE/v1/login -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"…"}'
# → 200 {"mfa_required":true,"mfa_token":"…"}

# Step 2: send the 6-digit TOTP code with the mfa_token.
curl -sS -X POST $BASE/v1/login/mfa -H 'content-type: application/json' \
  -d '{"mfa_token":"…","code":"123456"}'
# → 200 (full token pair, same shape as above)
```

### Refresh tokens

Refresh tokens rotate on every use. The previous refresh token is invalidated;
if it's ever replayed the entire session is revoked.

```sh
curl -sS -X POST $BASE/v1/token/refresh \
  -H 'content-type: application/json' \
  -d '{"refresh_token":"…"}'
# → 200 (new access_token + new refresh_token)
```

### Log out

```sh
curl -sS -X POST $BASE/v1/logout \
  -H "authorization: Bearer $ACCESS" \
  -H 'content-type: application/json' \
  -d '{"refresh_token":"…"}'
# → 204
```

### Current user

```sh
curl -sS $BASE/v1/me -H "authorization: Bearer $ACCESS"
# → 200 {"id":"…","email":"…","email_verified":true,"status":"active","created_at":"…"}
```

---

## 2. Password management

### Forgot password (unauthenticated)

```sh
curl -sS -X POST $BASE/v1/password/forgot \
  -H 'content-type: application/json' \
  -d '{"email":"alice@example.com"}'
# → 202 {"status":"queued"}
```

### Reset with token (unauthenticated)

```sh
curl -sS -X POST $BASE/v1/password/reset \
  -H 'content-type: application/json' \
  -d '{"token":"<token-from-email>","new_password":"new strong passphrase"}'
# → 200 {"status":"reset"}
```

### Change password (authenticated)

```sh
curl -sS -X POST $BASE/v1/password/change \
  -H "authorization: Bearer $ACCESS" \
  -H 'content-type: application/json' \
  -d '{"current_password":"…","new_password":"…"}'
# → 204
```

---

## 3. TOTP MFA

### Begin enrollment

```sh
curl -sS -X POST $BASE/v1/mfa/totp/setup \
  -H "authorization: Bearer $ACCESS" \
  -H 'content-type: application/json' \
  -d '{"label":"My phone"}'
# → 200
# {
#   "factor_id":"…",
#   "secret":"JBSWY3DPEHPK3PXP",
#   "otpauth_uri":"otpauth://totp/…"
# }
```

Render `otpauth_uri` as a QR code in the client; the user scans it with their
authenticator app.

### Confirm enrollment

```sh
curl -sS -X POST $BASE/v1/mfa/totp/confirm \
  -H "authorization: Bearer $ACCESS" \
  -H 'content-type: application/json' \
  -d '{"factor_id":"…","code":"123456"}'
# → 204
```

### Remove a factor

```sh
curl -sS -X DELETE "$BASE/v1/mfa/totp/$FACTOR_ID" \
  -H "authorization: Bearer $ACCESS"
# → 204
```

---

## 4. Session management

### List active sessions

```sh
curl -sS $BASE/v1/sessions -H "authorization: Bearer $ACCESS"
# → 200 [{"id":"…","createdAt":"…","lastUsedAt":"…","ip":"…","userAgent":"…"}, …]
```

### Revoke a specific session

```sh
curl -sS -X DELETE "$BASE/v1/sessions/$SESSION_ID" \
  -H "authorization: Bearer $ACCESS"
# → 204
```

---

## 4a. Admin API

All admin endpoints require an access token whose `roles` claim contains
`"admin"`. Bootstrap the first admin via `npm run grant-admin --
--email=…` (see README); manage subsequent admins through this API.

### List users

```sh
curl -sS "$BASE/v1/admin/users?email=alice&status=ACTIVE&limit=20" \
  -H "authorization: Bearer $ACCESS"
# → 200 { users: [...], total: 42, limit: 20, offset: 0 }
```

Filters: `email` (case-insensitive substring), `status`, `role`. Pagination
via `limit` (default 50, max 200) and `offset`.

### Get full user detail

```sh
curl -sS "$BASE/v1/admin/users/$USER_ID" -H "authorization: Bearer $ACCESS"
# → 200 (summary fields + mfaFactors[], activeSessionCount)
```

### Update status / roles

```sh
curl -sS -X PATCH "$BASE/v1/admin/users/$USER_ID" \
  -H "authorization: Bearer $ACCESS" -H 'content-type: application/json' \
  -d '{"roles":["admin","support"]}'
# → 204

curl -sS -X PATCH "$BASE/v1/admin/users/$USER_ID" \
  -H "authorization: Bearer $ACCESS" -H 'content-type: application/json' \
  -d '{"status":"DISABLED"}'
# → 204    # also revokes every active session
```

An admin cannot drop their own `admin` role — another admin must do it.

### Force logout (revoke all sessions)

```sh
curl -sS -X POST "$BASE/v1/admin/users/$USER_ID/sessions/revoke-all" \
  -H "authorization: Bearer $ACCESS"
# → 200 { "revoked": 3 }
```

Useful after a role change: existing access tokens stay admin-capable
until they expire (≤ 15 min) or sessions are revoked.

### Read a user's audit log

```sh
curl -sS "$BASE/v1/admin/users/$USER_ID/audit?limit=50" \
  -H "authorization: Bearer $ACCESS"
# → 200 [{ id, event, ip, userAgent, metadata, createdAt }, ...]
```

Paginate by passing `before=<createdAt>` from the last item.

---

## 5. Service-to-service (OAuth2 client_credentials)

For machine clients (HR system, email worker, meeting bot, …). Provision a
client with `npm run create-client` and store the secret in the calling
service's secret store.

```sh
curl -sS -X POST $BASE/v1/oauth/token \
  -H 'content-type: application/json' \
  -d '{
    "grant_type":"client_credentials",
    "client_id":"hr-bot",
    "client_secret":"…",
    "scope":"users:read"
  }'
# → 200
# {
#   "access_token":"eyJ…",
#   "token_type":"Bearer",
#   "expires_in":3600,
#   "scope":"users:read"
# }
```

The returned access token is a normal JWT. Verify it in your service against
`/.well-known/jwks.json` — no callback to this service required.

### Per-app email branding

By default, `verify_email` and `password_reset` emails are sent from the
global `EMAIL_SERVICE_FROM` with generic subjects. If a `ServiceClient` row
has any of `fromAddress`, `verifyEmailSubject`, `passwordResetSubject` set,
those values are used instead — but only for users who registered through
that client.

To "register through" a client, the client's backend forwards the user's
register call with its own service-to-service access token attached:

```sh
# 1. Service gets a token (as above)
SERVICE_TOKEN=$(curl -sS -X POST $BASE/v1/oauth/token \
  -H 'content-type: application/json' \
  -d '{"grant_type":"client_credentials","client_id":"hr-bot","client_secret":"…"}' \
  | jq -r .access_token)

# 2. Service proxies the user's registration with the token
curl -sS -X POST $BASE/v1/register \
  -H "authorization: Bearer $SERVICE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"…"}'
```

The `client_id` is read from the token's claims, never from the request body
— a malicious caller cannot impersonate another service's `From` address
without that service's `client_secret`.

Subsequent emails for that user (verification resends, password resets) are
automatically branded from the same client because `User.registeredClientId`
was recorded on registration.

If no service token is attached, register still works and falls back to
global defaults — existing public callers are unaffected.

To configure branding, set `fromAddress`, `verifyEmailSubject`, and/or
`passwordResetSubject` directly on the `ServiceClient` row (any null field
falls back to the global default). Sender domains must be verified in
mailnowapi separately.

---

## 6. Discovery (for verifying services)

Any service that needs to verify a token only needs these two endpoints:

```sh
curl -sS $BASE/.well-known/openid-configuration
curl -sS $BASE/.well-known/jwks.json
```

Wire them into a JWT library (e.g. `jose`, `jsonwebtoken` + `jwks-rsa`) and
verify with `iss` = your `JWT_ISSUER` and `aud` = your `JWT_AUDIENCE`.

---

## 7. Errors

All errors share this shape:

```json
{ "code": "invalid_credentials", "message": "…", "issues": [ … ] }
```

| status | meaning                                                   |
|--------|-----------------------------------------------------------|
| 400    | malformed input (`issues` lists Zod validation problems)  |
| 401    | bad credentials, missing/expired bearer, replayed refresh |
| 403    | authenticated but not allowed                             |
| 404    | resource not found                                        |
| 409    | conflict (e.g. TOTP already enrolled)                     |
| 429    | rate limited                                              |
| 500    | unhandled — please file a bug                             |

`POST /v1/login`, `POST /v1/register`, and `POST /v1/password/forgot` are
behind the strictest rate limits.

---

## 8. Generating typed clients

The OpenAPI spec is committed at the repo root (`openapi.json`) and
regenerated automatically in CI, so you don't need to run the service to feed
a generator.

TypeScript:

```sh
npx openapi-typescript openapi.json -o auth-types.d.ts
```

OpenAPI Generator (any language):

```sh
npx @openapitools/openapi-generator-cli generate \
  -i openapi.json -g python -o ./auth-client-python
```

---

## 9. MCP server

Every endpoint above is also exposed as an MCP tool, so AI agents can call the
auth service via the Model Context Protocol without writing any client code.

Run it locally over stdio:

```sh
AUTH_API_BASE_URL=$BASE npm run mcp
```

Optional bearer for authenticated endpoints (otherwise pass it per-call via
the tool's `headers.authorization` argument):

```sh
AUTH_API_BASE_URL=$BASE AUTH_API_BEARER=$ACCESS npm run mcp
```

Wire it into Claude Desktop / Cursor / any MCP client by adding an entry like:

```json
{
  "mcpServers": {
    "auth": {
      "command": "npm",
      "args": ["run", "--silent", "mcp"],
      "cwd": "/path/to/auth",
      "env": {
        "AUTH_API_BASE_URL": "https://auth.example.com"
      }
    }
  }
}
```

The MCP server reads the same `openapi.json` everything else uses, so its
tool list is always in sync with the HTTP API. Tool inputs are an object with
optional `path`, `query`, `headers`, and `body` properties — only the ones the
endpoint actually uses are advertised in the tool's input schema.
