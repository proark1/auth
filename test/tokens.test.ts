import { describe, it, expect } from 'vitest';
import { generateToken, hashToken, tokensMatch } from '../src/crypto/tokens.js';

describe('tokens', () => {
  it('generates a base64url plaintext + sha256 hex hash', () => {
    const { plaintext, hash } = generateToken();
    expect(plaintext).toMatch(/^[A-Za-z0-9_-]+$/); // base64url charset
    expect(plaintext.length).toBeGreaterThan(40);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);        // sha256 hex
  });

  it('hashToken is deterministic', () => {
    expect(hashToken('hello')).toBe(hashToken('hello'));
    expect(hashToken('hello')).not.toBe(hashToken('hellO'));
  });

  it('plaintext != hash', () => {
    const { plaintext, hash } = generateToken();
    expect(plaintext).not.toBe(hash);
  });

  it('tokens are unique across calls', () => {
    const a = generateToken().plaintext;
    const b = generateToken().plaintext;
    expect(a).not.toBe(b);
  });

  it('tokensMatch is true for equal hex, false otherwise', () => {
    const h = hashToken('x');
    expect(tokensMatch(h, h)).toBe(true);
    expect(tokensMatch(h, hashToken('y'))).toBe(false);
    expect(tokensMatch(h, h.slice(0, -2))).toBe(false); // length mismatch
  });
});
