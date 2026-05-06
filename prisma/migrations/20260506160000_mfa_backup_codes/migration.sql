-- MFA backup codes. One row per single-use recovery code; codes are stored
-- as sha256 hex (codeHash) so a DB read alone can't be replayed.

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
CREATE UNIQUE INDEX "MfaBackupCode_codeHash_key" ON "MfaBackupCode"("codeHash");

-- CreateIndex
CREATE INDEX "MfaBackupCode_userId_idx" ON "MfaBackupCode"("userId");

-- AddForeignKey
ALTER TABLE "MfaBackupCode"
    ADD CONSTRAINT "MfaBackupCode_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
