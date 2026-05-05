-- Per-service email branding + remember which client a user registered through.
-- All columns nullable so existing rows are unaffected and emails fall back
-- to the global EMAIL_SERVICE_FROM / hardcoded subjects.

-- AlterTable
ALTER TABLE "ServiceClient"
    ADD COLUMN "fromAddress" TEXT,
    ADD COLUMN "verifyEmailSubject" TEXT,
    ADD COLUMN "passwordResetSubject" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "registeredClientId" UUID;

-- CreateIndex
CREATE INDEX "User_registeredClientId_idx" ON "User"("registeredClientId");

-- AddForeignKey
ALTER TABLE "User"
    ADD CONSTRAINT "User_registeredClientId_fkey"
    FOREIGN KEY ("registeredClientId") REFERENCES "ServiceClient"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
