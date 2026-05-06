-- MFA backup codes. One row per single-use recovery code; codes are stored
-- as peppered HMAC-SHA256 hex (codeHash) so a DB read alone can't be replayed
-- (see src/crypto/backupCodes.ts).
--
-- Uniqueness is per-user (userId, codeHash) rather than global: at 50 bits of
-- entropy a global unique would eventually collide for unrelated users and
-- surface as a 500 on regenerate. The composite index also covers user
-- lookups during consumeBackupCode().

-- CreateTable
CREATE TABLE "MfaBackupCode" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MfaBackupCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MfaBackupCode_userId_codeHash_key" ON "MfaBackupCode"("userId", "codeHash");

-- AddForeignKey
ALTER TABLE "MfaBackupCode"
    ADD CONSTRAINT "MfaBackupCode_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
