-- Coarse-grained user roles. Stamped into the access token's `roles` claim
-- and consulted by requireAdmin in the admin API. Existing users get an
-- empty array — no privilege change at deploy time. Bootstrap the first
-- admin via `npm run grant-admin -- --email=you@example.com`.

ALTER TABLE "User"
    ADD COLUMN "roles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
