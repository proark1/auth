import { describe, it, expect } from 'vitest';
import {
  generateBackupCode,
  generateBackupCodes,
  canonicalizeBackupCode,
  hashBackupCode,
  BACKUP_CODE_BATCH_SIZE,
} from '../src/crypto/backupCodes.js';

describe('backupCodes', () => {
  it('generates codes in XXXXX-XXXXX format from the safe alphabet', () => {
    const code = generateBackupCode();
    expect(code).toMatch(/^[A-HJ-KM-NP-Z2-9]{5}-[A-HJ-KM-NP-Z2-9]{5}$/);
    // Confusable chars must not appear: 0, O, 1, I, L
    expect(code).not.toMatch(/[01OIL]/);
  });

  it('batch contains the configured count of distinct codes', () => {
    const batch = generateBackupCodes();
    expect(batch).toHaveLength(BACKUP_CODE_BATCH_SIZE);
    expect(new Set(batch).size).toBe(BACKUP_CODE_BATCH_SIZE);
  });

  it('canonicalizes formatting and case so users can paste either form', () => {
    const code = generateBackupCode();
    const messy = `  ${code.toLowerCase().replace('-', ' - ')}  `;
    expect(canonicalizeBackupCode(messy)).toBe(canonicalizeBackupCode(code));
  });

  it('hashBackupCode is deterministic across formatting variants', () => {
    const code = generateBackupCode();
    const a = hashBackupCode(code);
    const b = hashBackupCode(code.toLowerCase());
    const c = hashBackupCode(code.replace('-', ''));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('hashBackupCode differs across distinct codes', () => {
    const a = hashBackupCode(generateBackupCode());
    const b = hashBackupCode(generateBackupCode());
    expect(a).not.toBe(b);
  });
});
