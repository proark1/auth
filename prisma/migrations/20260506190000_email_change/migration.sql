-- Email-address change requests. Token is sent to the *new* address (proof
-- of ownership); the user's current email is unchanged until they confirm.
-- Single-use, sha256-hashed at rest, short TTL.

-- CreateTable
CREATE TABLE "EmailChangeRequest" (
    "id"        UUID         NOT NULL,
    "userId"    UUID         NOT NULL,
    "newEmail"  CITEXT       NOT NULL,
    "tokenHash" TEXT         NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt"    TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailChangeRequest_tokenHash_key" ON "EmailChangeRequest"("tokenHash");

-- CreateIndex
CREATE INDEX "EmailChangeRequest_userId_idx" ON "EmailChangeRequest"("userId");

-- AddForeignKey
ALTER TABLE "EmailChangeRequest"
    ADD CONSTRAINT "EmailChangeRequest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
