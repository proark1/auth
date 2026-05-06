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

### Change email (authenticated)

```sh
# Step 1: prove possession of the password and request a swap to the new
# address. The confirm link goes to the *new* email — no change happens
# until the user clicks it.
curl -sS -X POST $BASE/v1/email/change/request \
  -H "authorization: Bearer $ACCESS" \
  -H 'content-type: application/json' \
  -d '{"current_password":"…","new_email":"alice2@example.com"}'
# → 202 {"status":"queued"}
```

```sh
# Step 2: confirm with the token from the email.
curl -sS -X POST $BASE/v1/email/change/confirm \
  -H 'content-type: application/json' \
  -d '{"token":"<token-from-email>"}'
# → 200 {"status":"changed","email":"alice2@example.com"}
```

On success, every active session for the user is revoked — email is the
recovery path for password reset, so a change forces fresh logins on
every device. Reusing a token, using it after the 1-hour expiry, or
confirming when the new address has been claimed in the meantime all
return 4xx.

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

### Log in via magic link (passwordless)

```sh
# Step 1: ask the server to email a one-shot sign-in link.
curl -sS -X POST $BASE/v1/login/magic/request \
  -H 'content-type: application/json' \
  -d '{"email":"alice@example.com"}'
# → 202 {"status":"queued"}
```

The request is silent on whether the address exists, is disabled, or is
unverified — it always returns 202. The user receives an email at
`/login/magic?token=...` (15-minute expiry, single use).

```sh
# Step 2: the page extracts the token and posts it to /verify.
curl -sS -X POST $BASE/v1/login/magic/verify \
  -H 'content-type: application/json' \
  -d '{"token":"<token-from-email>"}'
# → 200 (full token pair) — or, if the user has TOTP enrolled,
#       {"mfa_required":true,"mfa_token":"…"} and continue at /v1/login/mfa.
```

Magic-link sign-in is treated as a first factor only: if the user has TOTP
enrolled, the flow funnels through the same `/v1/login/mfa` exchange as a
password login. This keeps the second-factor policy in one place.

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

### Export my data (GDPR)

```sh
curl -sS -O -J $BASE/v1/me/data -H "authorization: Bearer $ACCESS"
# → saves auth-export-<userId>.json with everything we hold
```

The JSON contains the user row, every session, MFA factor, email-token,
and audit event. Secrets are elided (TOTP secret bytes, refresh-token
hashes, password hash) — only their presence is reflected.

### Delete my account

```sh
# Step 1: prove possession of the password and request a confirm email.
curl -sS -X POST $BASE/v1/me/delete/request \
  -H "authorization: Bearer $ACCESS" \
  -H 'content-type: application/json' \
  -d '{"current_password":"…"}'
# → 202 {"status":"queued"}

# Step 2: confirm with the emailed token.
curl -sS -X POST $BASE/v1/me/delete/confirm \
  -H 'content-type: application/json' \
  -d '{"token":"<token-from-email>"}'
# → 200 {"status":"deleted"}
```

Confirming hard-deletes the user. Sessions, MFA factors, and pending
tokens cascade. Audit events stay in the log with `userId` nulled —
useful for security review and not regulated as PII once the user
link is severed.

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

### Backup (recovery) codes

After confirming a TOTP factor, generate a batch of single-use recovery
codes so the user isn't locked out if they lose their phone:

```sh
curl -sS -X POST $BASE/v1/mfa/backup-codes/regenerate \
  -H "authorization: Bearer $ACCESS"
# → 200
# { "codes":["A2K7X-MQ4PN", "Z9HJF-KR3VW", …], "count":10 }
```

Display the codes to the user **once** — they're hashed at rest and can't
be retrieved again. Calling regenerate a second time invalidates the old
batch atomically.

Check how many codes are still unused:

```sh
curl -sS $BASE/v1/mfa/backup-codes -H "authorization: Bearer $ACCESS"
# → 200 { "remaining": 9 }
```

If the user has lost their TOTP device, they complete login with a
backup code instead:

```sh
curl -sS -X POST $BASE/v1/login/mfa/recovery \
  -H 'content-type: application/json' \
  -d "{\"mfa_token\":\"$MFA_TOKEN\",\"backup_code\":\"A2K7X-MQ4PN\"}"
# → 200 { access_token, refresh_token, … }
```

Each code is single-use; consumed codes can never be replayed.

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

### Per-client tenant isolation and branding

Each `ServiceClient` (HR, onetab.ai, …) is a tenant. The auth service
isolates them via two per-client fields, both optional and falling back to
global defaults when null:

| Field          | What it controls                                     | Visibility        |
|----------------|------------------------------------------------------|-------------------|
| `audience`     | `aud` claim on access tokens for this client's users | Inside the JWT    |
| `webBaseUrl`   | Origin used for verify / reset links in emails       | End user (email)  |
| `fromAddress`  | `From:` of outgoing emails                           | End user (email)  |
| `verifyEmailSubject` / `passwordResetSubject` | Email subjects     | End user (email)  |

`audience` is the security boundary: each consumer validates `aud` against
its **own** audience, so an HR-issued token cannot be replayed against
onetab.ai (and vice versa) even though both validate the same `iss` and the
same JWKS.

A user is associated with a client by registering through it. The client's
backend forwards the register call with its own service-to-service token
attached:

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

The `client_id` is read from the token's claims, never from the request
body — a malicious caller cannot impersonate another service's audience or
`From:` address without that service's `client_secret`.

Subsequent tokens, emails, and reset links for that user automatically use
the same client's settings because `User.registeredClientId` was recorded on
registration.

If no service token is attached, register still works and falls back to the
global `JWT_AUDIENCE` / `WEB_BASE_URL` / `EMAIL_SERVICE_FROM` — existing
public callers are unaffected.

Configure these fields when creating the client (`npm run create-client
--audience=… --web-base-url=…`) or via the admin endpoints
(`POST/PATCH /v1/admin/clients`). Sender domains must be verified in
mailnowapi separately.

### Self-discovery (for the calling service)

Integrators don't need to mirror `audience` (or any other config) in their
own env vars. With a service token they can fetch their own public config:

```sh
curl -sS $BASE/v1/clients/me \
  -H "authorization: Bearer $SERVICE_TOKEN"
# → 200
# {
#   "clientId":"svc_abc123",
#   "name":"HR Service",
#   "scopes":["users:read"],
#   "audience":"hr-service",
#   "webBaseUrl":"https://hr.yourco.com"
# }
```

Combined with `/.well-known/openid-configuration`, this means an integrating
service only needs **two** env vars: `AUTH_API_URL` and its
`AUTH_CLIENT_ID` / `AUTH_CLIENT_SECRET`. Issuer and audience are discovered
at startup.

---

## 6. Discovery (for verifying services)

Any service that needs to verify a token only needs these two endpoints:

```sh
curl -sS $BASE/.well-known/openid-configuration
curl -sS $BASE/.well-known/jwks.json
```

Wire them into a JWT library (e.g. `jose`, `jsonwebtoken` + `jwks-rsa`) and
verify with `iss` from the discovery doc and `aud` = **your client's
audience** (fetched once from `/v1/clients/me`, see § 5). Each consumer's
audience is distinct, so an HR-issued token does not validate at onetab.ai
even though both share the same issuer and JWKS.

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
