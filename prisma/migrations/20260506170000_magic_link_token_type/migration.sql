-- Magic-link login: extend the EmailTokenType enum so a single random-token
-- table covers verify-email, password-reset, and now magic-link login.
-- Postgres' ALTER TYPE ... ADD VALUE is idempotent only with IF NOT EXISTS.

ALTER TYPE "EmailTokenType" ADD VALUE IF NOT EXISTS 'LOGIN_MAGIC_LINK';
