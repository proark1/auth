import argon2 from 'argon2';

// Argon2id parameters — OWASP 2024 minimums for password hashing.
// argon2 library encodes params + salt into the returned string, so verify()
// reads them back. Bumping these later only affects new hashes; old hashes
// keep verifying with their original params.
const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, HASH_OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export function needsRehash(hash: string): boolean {
  return argon2.needsRehash(hash, HASH_OPTIONS);
}
