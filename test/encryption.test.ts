import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.DATABASE_URL = 'postgresql://x/x';
  process.env.REDIS_URL = 'redis://x';
  process.env.JWT_ISSUER = 'https://auth.test';
  process.env.JWT_AUDIENCE = 'test';
});

describe('encryption (AES-256-GCM)', async () => {
  const { encrypt, decrypt } = await import('../src/crypto/encryption.js');

  it('round-trips strings', () => {
    const blob = encrypt('hello world');
    expect(decrypt(blob).toString('utf8')).toBe('hello world');
  });

  it('round-trips binary', () => {
    const data = randomBytes(64);
    expect(decrypt(encrypt(data)).equals(data)).toBe(true);
  });

  it('produces distinct ciphertexts for the same plaintext (random nonce)', () => {
    const a = encrypt('same');
    const b = encrypt('same');
    expect(a.equals(b)).toBe(false);
  });

  it('rejects tampered ciphertext (GCM auth tag)', () => {
    const blob = encrypt('hello');
    blob[blob.length - 1] ^= 0xff; // flip a tag byte
    expect(() => decrypt(blob)).toThrow();
  });

  it('rejects too-short blobs', () => {
    expect(() => decrypt(Buffer.alloc(4))).toThrow();
  });
});
