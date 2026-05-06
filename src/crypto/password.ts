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

// Lazily-computed argon2 hash used to equalize login timing when the email
// doesn't exist. Without this, the no-user branch returns ~50ms faster than
// the wrong-password branch and an attacker can enumerate accounts even
// though the response shape is identical.
//
// The plaintext that seeds this hash is generated once at process start from
// a CSPRNG and immediately discarded, so verifying any user input against it
// returns false in roughly the same time as a real verify.
let dummyHashPromise: Promise<string> | undefined;

function getDummyHash(): Promise<string> {
  // Assign the promise synchronously so a burst of concurrent callers all
  // await the same single argon2.hash, instead of each spawning their own
  // before the first one finishes (the previous `await import` between the
  // check and the assignment yielded the event loop, allowing duplicate
  // computations under a login burst).
  if (!dummyHashPromise) {
    dummyHashPromise = (async () => {
      const { randomBytes } = await import('node:crypto');
      return argon2.hash(randomBytes(32).toString('base64'), HASH_OPTIONS);
    })();
  }
  return dummyHashPromise;
}

export async function verifyDummyPassword(plain: string): Promise<void> {
  // Best-effort timing equalizer. Errors are swallowed: an unexpected hash
  // failure mustn't change the calling endpoint's behavior.
  try {
    const hash = await getDummyHash();
    await argon2.verify(hash, plain);
  } catch {
    /* ignore */
  }
}
