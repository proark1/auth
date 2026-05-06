import { z } from 'zod';

// JWT claim shape we own. Independent of any specific provider (Supabase etc).
// Other services validate this schema on the JWT they receive.

export const accessClaimsSchema = z.object({
  iss: z.string().url(),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string().uuid(),         // user id
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string(),                // unique per token
  typ: z.literal('access'),

  email: z.string().email().optional(),
  email_verified: z.boolean().optional(),
  roles: z.array(z.string()).default([]),
  org_id: z.string().uuid().optional(),
  // Fine-grained permissions are resolved per-service from a shared config,
  // not stamped into the JWT, to keep tokens small.
});

export type AccessClaims = z.infer<typeof accessClaimsSchema>;

export const serviceClaimsSchema = z.object({
  iss: z.string().url(),
  aud: z.literal('service'),
  sub: z.string(),                // service client_id
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string(),
  typ: z.literal('service'),
  scope: z.string().optional(),
});

export type ServiceClaims = z.infer<typeof serviceClaimsSchema>;

// Short-lived challenge token issued by /v1/login when a user has a confirmed
// MFA factor. Caller exchanges it + a TOTP code for a real session via
// /v1/login/mfa. Not a usable access token — `requireUser` rejects typ != access.
export const mfaClaimsSchema = z.object({
  iss: z.string().url(),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string().uuid(),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string(),
  typ: z.literal('mfa'),
});

export type MfaClaims = z.infer<typeof mfaClaimsSchema>;

// Short-lived WebAuthn ceremony token. We hand the random 32-byte challenge
// (`chal`, base64url) to the client wrapped in a server-signed JWT instead of
// persisting it: round-tripping a signed challenge avoids a per-ceremony DB
// row. `purpose` distinguishes registration (sub = userId) from discoverable
// authentication (sub absent — the credential's userHandle resolves the
// account at verify time).
export const webauthnChallengeClaimsSchema = z.object({
  iss: z.string().url(),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string().uuid().optional(),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string(),
  typ: z.literal('webauthn'),
  purpose: z.enum(['register', 'authenticate']),
  chal: z.string().min(1),
});

export type WebauthnChallengeClaims = z.infer<typeof webauthnChallengeClaimsSchema>;
