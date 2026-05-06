import { env } from '../infra/env.js';

// WebAuthn relying-party configuration.
//
//   rpID:     the eTLD+1 (or registrable subdomain) the browser shows in the
//             credential prompt. Must match `window.location.hostname` *or be
//             a registrable suffix of it*. Defaults to the JWT_ISSUER host so
//             the auth API and login UI agree out of the box; override with
//             WEBAUTHN_RP_ID to share credentials across subdomains.
//
//   rpName:   human-readable label, shown by some platform UIs.
//
//   origins:  explicit allowlist the browser may legitimately call from.
//             SimpleWebAuthn accepts an array; we always pass an array so
//             callers don't have to special-case the single-origin case.
//             Defaults to [WEB_BASE_URL].
//
// Cached per process — these inputs don't change at runtime.
export interface WebauthnConfig {
  rpID: string;
  rpName: string;
  origins: string[];
}

let cached: WebauthnConfig | undefined;

export function webauthnConfig(): WebauthnConfig {
  if (cached) return cached;
  const e = env();
  const rpID = e.WEBAUTHN_RP_ID ?? new URL(e.JWT_ISSUER).hostname;
  const origins = (e.WEBAUTHN_ORIGINS ?? e.WEB_BASE_URL)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  cached = { rpID, rpName: e.WEBAUTHN_RP_NAME, origins };
  return cached;
}

// Test hook — discard the cache so a test that mutates env vars sees them.
export function _resetWebauthnConfigCache(): void {
  cached = undefined;
}
