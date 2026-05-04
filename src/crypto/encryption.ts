import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../infra/env.js';

// AES-256-GCM. Layout: [12-byte nonce][ciphertext][16-byte auth tag].
// Used to wrap signing private keys and TOTP secrets at rest.

const ALG = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function key(): Buffer {
  const raw = Buffer.from(env().APP_ENCRYPTION_KEY, 'base64');
  if (raw.length !== 32) {
    throw new Error('APP_ENCRYPTION_KEY must decode to 32 bytes (base64)');
  }
  return raw;
}

export function encrypt(plaintext: Buffer | string): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALG, key(), nonce);
  const pt = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]);
}

export function decrypt(blob: Buffer): Buffer {
  if (blob.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error('ciphertext too short');
  }
  const nonce = blob.subarray(0, NONCE_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const ct = blob.subarray(NONCE_BYTES, blob.length - TAG_BYTES);
  const decipher = createDecipheriv(ALG, key(), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
