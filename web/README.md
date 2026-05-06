# myauthservice web

Marketing landing + login/register UI for myauthservice. Deployed to Vercel
with **Root Directory = `web`**. Talks to the Fastify API at
`AUTH_API_URL` over HTTPS, server-side only.

## Local dev

From the **repo root**, run the API:

```sh
docker compose up -d
npm install
npm run prisma:migrate
npm run dev          # starts the API on :8080
```

In a second shell, from `web/`:

```sh
cp .env.example .env.local
# edit .env.local: set AUTH_API_URL=http://localhost:8080
npm install
npm run dev          # starts Next.js on :3000
```

Open <http://localhost:3000>.

## Deploy

Vercel project → Settings:

- **Root Directory**: `web`
- **Framework Preset**: Next.js (auto-detected)
- **Environment Variables**:
  - `AUTH_API_URL=https://auth.myauthservice.com`
  - `NEXT_PUBLIC_SITE_URL=https://myauthservice.com`

Add the apex and `www` domains under Vercel → Domains. Redirect `www` → apex.

## Architecture

```
browser ──HTTPS──► Next.js (Vercel, myauthservice.com)
                       │
                       │ Route Handlers (app/api/auth/**)
                       ▼
                   Fastify API (Railway, auth.myauthservice.com)
```

Browser only ever talks to Next.js. Auth tokens are issued by the Fastify
API, returned to Next.js, and set as `httpOnly` cookies on the browser
response. Refresh tokens never reach client JS.
