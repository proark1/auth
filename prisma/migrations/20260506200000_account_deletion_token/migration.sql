-- Account-deletion confirm token: extend EmailTokenType so deletion uses the
-- same single-use, sha256-hashed token plumbing as verify-email and reset.

ALTER TYPE "EmailTokenType" ADD VALUE IF NOT EXISTS 'ACCOUNT_DELETION';
