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
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),

  EMAIL_SERVICE_URL: z.string().url().optional(),
  EMAIL_SERVICE_TOKEN: z.string().optional(),
  EMAIL_SERVICE_FROM: z.string().email().optional(),
  VERIFY_EMAIL_TEMPLATE_ID: z.string().uuid().optional(),
  PASSWORD_RESET_TEMPLATE_ID: z.string().uuid().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}
