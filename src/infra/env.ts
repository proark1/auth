import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // 32 bytes, base64-encoded. Used for AES-256-GCM encryption-at-rest of
  // signing private keys and TOTP secrets.
  APP_ENCRYPTION_KEY: z.string().min(1),

  JWT_ISSUER: z.string().url(),
  JWT_AUDIENCE: z.string().min(1),

  // Public origin of the frontend (Next.js app). Used to build links in
  // outgoing emails (verify-email, password reset). Distinct from JWT_ISSUER,
  // which points at the API host.
  WEB_BASE_URL: z.string().url(),

  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),

  EMAIL_SERVICE_URL: z.string().url().optional(),
  EMAIL_SERVICE_TOKEN: z.string().optional(),
  EMAIL_SERVICE_FROM: z.string().email().optional(),
  VERIFY_EMAIL_TEMPLATE_ID: z.string().uuid().optional(),
  PASSWORD_RESET_TEMPLATE_ID: z.string().uuid().optional(),
  NEW_DEVICE_LOGIN_TEMPLATE_ID: z.string().uuid().optional(),
  EMAIL_CHANGE_TEMPLATE_ID: z.string().uuid().optional(),
  ACCOUNT_DELETION_TEMPLATE_ID: z.string().uuid().optional(),
  MAGIC_LINK_TEMPLATE_ID: z.string().uuid().optional(),
  REGISTER_EXISTING_ACCOUNT_TEMPLATE_ID: z.string().uuid().optional(),

  // Compromised-password check via the haveibeenpwned k-anonymity API.
  // - HIBP_ENABLED: opt-in. When false, register/reset/change are not
  //   blocked on a leaked-password match (and never make the outbound HTTP).
  // - HIBP_THRESHOLD: minimum prefix-suffix count to consider a password
  //   "compromised". 1 = block any match (most aggressive); 100 = block only
  //   passwords seen in 100+ breaches (more permissive). Defaults to 1.
  // - HIBP_TIMEOUT_MS: request timeout. Failures fail OPEN — we don't block
  //   sign-ups when HIBP is having a bad day. Defaults to 2s.
  // z.coerce.boolean() treats any non-empty string as true (so "false"
  // becomes true). Parse the literal text instead.
  HIBP_ENABLED: z
    .string()
    .optional()
    .transform((v) => v?.toLowerCase() === 'true' || v === '1'),
  HIBP_THRESHOLD: z.coerce.number().int().min(1).default(1),
  HIBP_TIMEOUT_MS: z.coerce.number().int().min(100).default(2000),

  // Email retry worker. When enabled, the API process drains the
  // PendingEmail queue on a timer. Off in test/CI; on in any deployment.
  EMAIL_WORKER_ENABLED: z
    .string()
    .optional()
    .transform((v) => v?.toLowerCase() === 'true' || v === '1'),
  EMAIL_WORKER_POLL_MS: z.coerce.number().int().min(1000).default(15_000),

  // "We noticed a sign-in from a new device/network" notification email.
  // Off by default. When on, issueSession compares the new session's IP
  // against the user's prior sessions in the last NEW_DEVICE_WINDOW_DAYS;
  // if no prior session matched, an informational email is sent.
  // Failures don't break login.
  NEW_DEVICE_EMAIL_ENABLED: z
    .string()
    .optional()
    .transform((v) => v?.toLowerCase() === 'true' || v === '1'),
  NEW_DEVICE_WINDOW_DAYS: z.coerce.number().int().min(1).default(90),

  // WebAuthn / Passkeys.
  // - WEBAUTHN_RP_ID: the effective domain (eTLD+1 or a subdomain of it) the
  //   user sees in the credential prompt. Browsers refuse credentials whose
  //   RP ID isn't a registrable suffix of `window.location.hostname`. Defaults
  //   to the JWT_ISSUER host.
  // - WEBAUTHN_RP_NAME: human-readable label shown in some prompts.
  // - WEBAUTHN_ORIGINS: comma-separated list of origins the browser will be
  //   on when calling navigator.credentials. Usually the WEB_BASE_URL plus any
  //   alternate hostnames; defaults to WEB_BASE_URL.
  WEBAUTHN_RP_ID: z.string().min(1).optional(),
  WEBAUTHN_RP_NAME: z.string().min(1).default('Auth Service'),
  WEBAUTHN_ORIGINS: z.string().min(1).optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}

// Test hook — discard the cache so a test that mutates process.env sees them.
export function _resetEnvCache(): void {
  cached = undefined;
}
