import { prisma } from '../infra/db.js';
import { audit } from '../infra/audit.js';
import { AppError } from '../middleware/errors.js';
import {
  generateBackupCodes,
  hashBackupCode,
  BACKUP_CODE_BATCH_SIZE,
} from '../crypto/backupCodes.js';

interface RequestCtx {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

// Generate a fresh batch and atomically replace any existing codes.
// Plaintext codes are returned exactly once — the caller must show them
// to the user and forget them.
//
// Requires the user to have at least one *confirmed* MFA factor: backup codes
// only mean something as a fallback for an enrolled MFA. Asking for them
// before enrollment would create dangling rows that recover... nothing.
export async function regenerateBackupCodes(
  userId: string,
  ctx: RequestCtx = {},
): Promise<string[]> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, 'not_found', 'user not found');

  const enrolledCount = await prisma.mfaFactor.count({
    where: { userId, confirmedAt: { not: null } },
  });
  if (enrolledCount === 0) {
    throw new AppError(
      400,
      'mfa_not_enrolled',
      'enroll an MFA factor before generating backup codes',
    );
  }

  const codes = generateBackupCodes(BACKUP_CODE_BATCH_SIZE);
  const rows = codes.map((code) => ({ userId, codeHash: hashBackupCode(code) }));

  await prisma.$transaction([
    prisma.mfaBackupCode.deleteMany({ where: { userId } }),
    prisma.mfaBackupCode.createMany({ data: rows }),
  ]);

  await audit({ event: 'mfa.backup_codes.regenerated', userId, ...ctx });
  return codes;
}

// Returns the number of unused codes still on the account (no plaintext).
// Used by the UI to nudge users to regenerate when they're running low.
export async function countUnusedBackupCodes(userId: string): Promise<number> {
  return prisma.mfaBackupCode.count({ where: { userId, usedAt: null } });
}

// Try to consume one backup code as a second factor. Returns true on success.
// Single-use: a successful code is marked usedAt and cannot be reused.
//
// We do a hash lookup scoped to the user so a code stolen from one account
// can't be replayed against another (unique index makes collisions impossible
// in practice, but the userId scope is defense in depth).
export async function consumeBackupCode(
  userId: string,
  plaintext: string,
): Promise<boolean> {
  const codeHash = hashBackupCode(plaintext);
  // Atomic claim: updateMany with where: usedAt: null prevents two concurrent
  // attempts from both succeeding on the same code.
  const result = await prisma.mfaBackupCode.updateMany({
    where: { userId, codeHash, usedAt: null },
    data: { usedAt: new Date() },
  });
  return result.count === 1;
}
