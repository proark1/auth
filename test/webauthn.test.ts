import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { _resetEnvCache } from '../src/infra/env.js';
import { webauthnConfig, _resetWebauthnConfigCache } from '../src/crypto/webauthn.js';

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.DATABASE_URL = 'postgresql://x/x';
  process.env.REDIS_URL = 'redis://x';
  process.env.JWT_ISSUER = 'https://auth.example.com';
  process.env.JWT_AUDIENCE = 'test';
  process.env.WEB_BASE_URL = 'https://app.example.com';
  delete process.env.WEBAUTHN_RP_ID;
  delete process.env.WEBAUTHN_ORIGINS;
  delete process.env.WEBAUTHN_RP_NAME;
  _resetEnvCache();
  _resetWebauthnConfigCache();
});

describe('webauthn config', () => {
  it('defaults rpID to JWT_ISSUER hostname and origins to WEB_BASE_URL', () => {
    const cfg = webauthnConfig();
    expect(cfg.rpID).toBe('auth.example.com');
    expect(cfg.origins).toEqual(['https://app.example.com']);
    expect(cfg.rpName).toBe('Auth Service'); // schema default
  });

  it('honors WEBAUTHN_RP_ID and a comma-separated WEBAUTHN_ORIGINS allowlist', () => {
    process.env.WEBAUTHN_RP_ID = 'example.com';
    process.env.WEBAUTHN_ORIGINS = 'https://app.example.com, https://www.example.com';
    process.env.WEBAUTHN_RP_NAME = 'Acme Auth';
    _resetEnvCache();
    _resetWebauthnConfigCache();

    const cfg = webauthnConfig();
    expect(cfg.rpID).toBe('example.com');
    expect(cfg.origins).toEqual([
      'https://app.example.com',
      'https://www.example.com',
    ]);
    expect(cfg.rpName).toBe('Acme Auth');
  });
});
