-- Pending email queue. When the upstream mailer is unavailable, sendEmail
-- persists the message here so the calling request still succeeds; a retry
-- worker drains rows whose nextAttemptAt has passed.

-- CreateTable
CREATE TABLE "PendingEmail" (
    "id"            UUID         NOT NULL,
    "recipient"     TEXT         NOT NULL,
    "template"      TEXT         NOT NULL,
    "vars"          JSONB        NOT NULL,
    "clientId"      UUID,
    "attempts"      INTEGER      NOT NULL DEFAULT 0,
    "lastError"     TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt"        TIMESTAMP(3),
    "failedAt"      TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — covers the worker's "what should I send next?" query.
CREATE INDEX "PendingEmail_sentAt_nextAttemptAt_idx"
  ON "PendingEmail" ("sentAt", "nextAttemptAt");
