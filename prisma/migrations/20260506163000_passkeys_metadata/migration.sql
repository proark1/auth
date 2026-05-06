-- Passkey support: add browser-hint transports and AAGUID device-identifier
-- columns to MfaFactor. The credentialId / publicKey / signCount columns were
-- already reserved on the initial schema. transports/aaguid are populated by
-- the WebAuthn registration response and improve UX (correct credential
-- picker hints, friendly device labels) but aren't required for verification,
-- so existing rows can keep their defaults.

-- AlterTable
ALTER TABLE "MfaFactor"
    ADD COLUMN "transports" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "aaguid"     TEXT;
