import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

// Opaque tokens for email verification + password reset.
// Plaintext is shown to the user once (delivered via email).
// We persist sha256(token) — never the plaintext.

const TOKEN_BYTES = 32;

export function generateToken(): { plaintext: string; hash: string } {
  const plaintext = randomBytes(TOKEN_BYTES).toString('base64url');
  return { plaintext, hash: hashToken(plaintext) };
}

export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

// Constant-time comparison for hex hashes.
export function tokensMatch(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length) return false;
  return timingSafeEqual(Buffer.from(aHex, 'hex'), Buffer.from(bHex, 'hex'));
}
