import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, needsRehash } from '../src/crypto/password.js';

describe('password', () => {
  it('hashes and verifies', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });

  it('produces distinct hashes for the same input (random salt)', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
  });

  it('returns false (not throw) on a malformed hash', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });

  it('does not flag a fresh hash for rehash', async () => {
    const h = await hashPassword('x');
    expect(needsRehash(h)).toBe(false);
  });
});
