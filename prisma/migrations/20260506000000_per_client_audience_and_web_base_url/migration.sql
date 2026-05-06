-- Per-service token audience + per-service web origin.
-- Both nullable so existing rows are unaffected and fall back to the
-- env-level JWT_AUDIENCE / WEB_BASE_URL.

ALTER TABLE "ServiceClient"
    ADD COLUMN "audience"   TEXT,
    ADD COLUMN "webBaseUrl" TEXT;
