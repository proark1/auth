-- CreateTable
CREATE TABLE "ServiceClient" (
    "id" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "ServiceClient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceClient_clientId_key" ON "ServiceClient"("clientId");

-- CreateIndex
CREATE INDEX "ServiceClient_disabled_idx" ON "ServiceClient"("disabled");

