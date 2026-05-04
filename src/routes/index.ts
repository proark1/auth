import type { FastifyInstance } from 'fastify';

// MVP route map. Handlers are stubs — wire them up incrementally.
// Conventions:
//   - All inputs validated with zod (registered via fastify-type-provider-zod).
//   - All write endpoints emit an AuditEvent.
//   - Public endpoints sit behind a stricter rate limit than authed ones.

export async function registerRoutes(app: FastifyInstance) {
  // --- Public discovery ---
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/.well-known/jwks.json', jwksHandler);
  app.get('/.well-known/openid-configuration', oidcDiscoveryHandler);

  // --- Registration & email verification ---
  app.post('/v1/register', registerHandler);
  app.post('/v1/email/verify', verifyEmailHandler);
  app.post('/v1/email/verify/resend', resendVerificationHandler);

  // --- Login / logout / token lifecycle ---
  app.post('/v1/login', loginHandler);                  // returns access+refresh, or { mfaRequired, mfaToken }
  app.post('/v1/login/mfa', loginMfaHandler);           // exchange mfaToken + TOTP code -> tokens
  app.post('/v1/token/refresh', refreshHandler);        // rotates refresh token
  app.post('/v1/logout', { preHandler: [requireUser] }, logoutHandler);

  // --- Password ---
  app.post('/v1/password/forgot', passwordForgotHandler);
  app.post('/v1/password/reset', passwordResetHandler);
  app.post('/v1/password/change', { preHandler: [requireUser] }, passwordChangeHandler);

  // --- Current user ---
  app.get('/v1/me', { preHandler: [requireUser] }, meHandler);

  // --- MFA (TOTP) ---
  app.post('/v1/mfa/totp/setup',  { preHandler: [requireUser] }, totpSetupHandler);   // returns provisioning URI
  app.post('/v1/mfa/totp/confirm',{ preHandler: [requireUser] }, totpConfirmHandler); // proves possession
  app.delete('/v1/mfa/totp/:id',  { preHandler: [requireUser] }, totpDeleteHandler);

  // --- Sessions ---
  app.get('/v1/sessions',          { preHandler: [requireUser] }, listSessionsHandler);
  app.delete('/v1/sessions/:id',   { preHandler: [requireUser] }, revokeSessionHandler);
}

// ---- Stub handlers (to be implemented) ----

async function jwksHandler() { return { keys: [] }; }
async function oidcDiscoveryHandler() { return {}; }
async function registerHandler()         { throw new Error('TODO'); }
async function verifyEmailHandler()      { throw new Error('TODO'); }
async function resendVerificationHandler(){ throw new Error('TODO'); }
async function loginHandler()            { throw new Error('TODO'); }
async function loginMfaHandler()         { throw new Error('TODO'); }
async function refreshHandler()          { throw new Error('TODO'); }
async function logoutHandler()           { throw new Error('TODO'); }
async function passwordForgotHandler()   { throw new Error('TODO'); }
async function passwordResetHandler()    { throw new Error('TODO'); }
async function passwordChangeHandler()   { throw new Error('TODO'); }
async function meHandler()               { throw new Error('TODO'); }
async function totpSetupHandler()        { throw new Error('TODO'); }
async function totpConfirmHandler()      { throw new Error('TODO'); }
async function totpDeleteHandler()       { throw new Error('TODO'); }
async function listSessionsHandler()     { throw new Error('TODO'); }
async function revokeSessionHandler()    { throw new Error('TODO'); }

// ---- Auth middleware stub ----

async function requireUser() {
  // Verify Authorization: Bearer <jwt>, attach req.user
  throw new Error('TODO');
}
