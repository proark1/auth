import { createHash } from 'node:crypto';
import { env } from '../infra/env.js';

// Compromised-password check via haveibeenpwned.com's pwnedpasswords k-anonymity
// API. We never send the user's password — only the first 5 hex chars of its
// SHA-1. The API responds with every full hash on that 5-prefix, in
// "SUFFIX:COUNT" lines; we look up our suffix locally.
//
// This is the recommended HIBP integration — see
// https://haveibeenpwned.com/API/v3#PwnedPasswords. SHA-1 is fine here: HIBP
// uses it because the source breach corpora are SHA-1; we never store the
// SHA-1, only use it for the lookup.

const ENDPOINT = 'https://api.pwnedpasswords.com/range/';

// Result is a count: 0 means "no match in HIBP corpus". A non-zero number is
// the breach count for that exact password — bigger = more widely known.
export interface HibpResult {
  /** sha1 prefix (5 hex) we sent — useful for logging/debugging */
  prefix: string;
  /** how many breaches contain this exact password (0 if not present) */
  count: number;
  /** true if the upstream call succeeded; false if we failed open on error/timeout */
  checked: boolean;
}

export async function checkPasswordPwned(
  password: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HibpResult> {
  const e = env();
  const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  if (!e.HIBP_ENABLED) {
    return { prefix, count: 0, checked: false };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), e.HIBP_TIMEOUT_MS);

  try {
    const res = await fetchImpl(`${ENDPOINT}${prefix}`, {
      // Add-Padding levels the response size so a network observer can't infer
      // the exact prefix from response length. Recommended by HIBP.
      headers: { 'Add-Padding': 'true' },
      signal: ac.signal,
    });
    if (!res.ok) {
      // HIBP returned non-200 — fail open.
      return { prefix, count: 0, checked: false };
    }
    const body = await res.text();
    // Each line: "SUFFIX:COUNT" where SUFFIX is uppercase hex (35 chars).
    for (const line of body.split('\n')) {
      const colon = line.indexOf(':');
      if (colon !== 35) continue;
      if (line.slice(0, colon) === suffix) {
        const count = parseInt(line.slice(colon + 1).trim(), 10);
        return { prefix, count: Number.isFinite(count) ? count : 1, checked: true };
      }
    }
    return { prefix, count: 0, checked: true };
  } catch {
    // Timeout, DNS error, etc. — fail open.
    return { prefix, count: 0, checked: false };
  } finally {
    clearTimeout(timer);
  }
}

// Convenience: returns true iff HIBP is enabled, the call succeeded, and the
// breach count meets the configured threshold. False on any failure or on
// HIBP being disabled — fail-open semantics.
export async function isPasswordCompromised(password: string): Promise<boolean> {
  const e = env();
  if (!e.HIBP_ENABLED) return false;
  const result = await checkPasswordPwned(password);
  return result.checked && result.count >= e.HIBP_THRESHOLD;
}
