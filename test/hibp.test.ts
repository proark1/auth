import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { _resetEnvCache } from '../src/infra/env.js';

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.DATABASE_URL = 'postgresql://x/x';
  process.env.REDIS_URL = 'redis://x';
  process.env.JWT_ISSUER = 'https://auth.test';
  process.env.JWT_AUDIENCE = 'test';
  process.env.WEB_BASE_URL = 'https://app.test';
  delete process.env.HIBP_ENABLED;
  delete process.env.HIBP_THRESHOLD;
  delete process.env.HIBP_TIMEOUT_MS;
  _resetEnvCache();
});

// SHA-1 of "password" is 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8 →
// prefix=5BAA6, suffix=1E4C9B93F3F0682250B6CF8331B7EE68FD8.
// SHA-1 of "correcthorsebatteryst" is also a known constant we can compute.
const PASSWORD_SUFFIX = '1E4C9B93F3F0682250B6CF8331B7EE68FD8';

describe('hibp', async () => {
  const { checkPasswordPwned, isPasswordCompromised } = await import('../src/crypto/hibp.js');

  it('skips the network call entirely when HIBP_ENABLED is false', async () => {
    process.env.HIBP_ENABLED = 'false';
    _resetEnvCache();

    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      return new Response('', { status: 200 });
    };

    const result = await checkPasswordPwned('password', fakeFetch);
    expect(calls).toBe(0);
    expect(result).toEqual({ prefix: '5BAA6', count: 0, checked: false });
    expect(await isPasswordCompromised('password')).toBe(false);
  });

  it('reports the breach count when the suffix is in the response', async () => {
    process.env.HIBP_ENABLED = 'true';
    _resetEnvCache();

    const fakeFetch: typeof fetch = async (url) => {
      expect(String(url)).toBe('https://api.pwnedpasswords.com/range/5BAA6');
      return new Response(
        // include some other lines to make sure parsing finds the right one
        `0000000000000000000000000000000000A:5\r\n${PASSWORD_SUFFIX}:12345\r\nAAAA0:7`,
        { status: 200 },
      );
    };

    const result = await checkPasswordPwned('password', fakeFetch);
    expect(result.checked).toBe(true);
    expect(result.count).toBe(12345);
  });

  it('returns count=0 when the suffix is not in the response', async () => {
    process.env.HIBP_ENABLED = 'true';
    _resetEnvCache();

    const fakeFetch: typeof fetch = async () =>
      new Response('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1:1', { status: 200 });

    const result = await checkPasswordPwned('password', fakeFetch);
    expect(result.checked).toBe(true);
    expect(result.count).toBe(0);
  });

  it('fails open on non-200 upstream responses', async () => {
    process.env.HIBP_ENABLED = 'true';
    _resetEnvCache();

    const fakeFetch: typeof fetch = async () => new Response('', { status: 500 });

    const result = await checkPasswordPwned('password', fakeFetch);
    expect(result.checked).toBe(false);
    expect(result.count).toBe(0);
  });

  it('fails open on fetch throwing (network error / timeout)', async () => {
    process.env.HIBP_ENABLED = 'true';
    _resetEnvCache();

    const fakeFetch: typeof fetch = async () => {
      throw new Error('ECONNREFUSED');
    };

    const result = await checkPasswordPwned('password', fakeFetch);
    expect(result.checked).toBe(false);
    expect(result.count).toBe(0);
  });
});
