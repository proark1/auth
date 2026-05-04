import { authenticator } from 'otplib';
import { encrypt, decrypt } from './encryption.js';

// Allow ±1 30-second step (≈60s of clock skew tolerance). RFC 6238 says
// "no more than one step", so window=1 is the standard pick.
authenticator.options = { window: 1 };

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function totpKeyuri(args: { account: string; issuer: string; secret: string }): string {
  return authenticator.keyuri(args.account, args.issuer, args.secret);
}

export function verifyTotp(secret: string, code: string): boolean {
  try {
    return authenticator.verify({ token: code, secret });
  } catch {
    return false;
  }
}

export function encryptTotpSecret(secret: string): Buffer {
  return encrypt(secret);
}

export function decryptTotpSecret(blob: Buffer): string {
  return decrypt(blob).toString('utf8');
}
