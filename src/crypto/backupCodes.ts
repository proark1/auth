import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

// Backup-code format: 10 codes per batch, each 10 chars from a Crockford-base32
// alphabet (no 0/O/1/I/L). Codes are formatted XXXXX-XXXXX for readability.
// Per-code entropy: 10 chars * log2(32) = 50 bits — enough to resist online
// brute-force given our rate limiting, and small enough for a human to type.
//
// We store only sha256(canonicalize(code)) so a leaked DB row can't be replayed.
// canonicalize() strips formatting and case so users can paste either form.

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 31 chars: drop 0,O,1,I,L
const CODE_CHARS = 10;
export const BACKUP_CODE_BATCH_SIZE = 10;

export function generateBackupCode(): string {
  // Reject-sample uniformly across ALPHABET to avoid modulo bias.
  const out: string[] = [];
  const bound = 256 - (256 % ALPHABET.length);
  while (out.length < CODE_CHARS) {
    for (const byte of randomBytes(CODE_CHARS * 2)) {
      if (byte >= bound) continue;
      out.push(ALPHABET[byte % ALPHABET.length]!);
      if (out.length === CODE_CHARS) break;
    }
  }
  // Format XXXXX-XXXXX for readability.
  return `${out.slice(0, 5).join('')}-${out.slice(5).join('')}`;
}

export function generateBackupCodes(n = BACKUP_CODE_BATCH_SIZE): string[] {
  return Array.from({ length: n }, () => generateBackupCode());
}

// Strip dashes/whitespace and uppercase so users can paste either format.
export function canonicalizeBackupCode(input: string): string {
  return input.replace(/[\s-]+/g, '').toUpperCase();
}

export function hashBackupCode(plaintext: string): string {
  return createHash('sha256').update(canonicalizeBackupCode(plaintext)).digest('hex');
}

// Constant-time hex comparison helper (parity with crypto/tokens.ts).
export function backupCodesMatch(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length) return false;
  return timingSafeEqual(Buffer.from(aHex, 'hex'), Buffer.from(bHex, 'hex'));
}
