-- Adds a role enum on User. Defaults to USER for all existing rows so the
-- migration is non-disruptive. The first ADMIN is bootstrapped manually:
--   UPDATE "User" SET role = 'ADMIN' WHERE email = '<bootstrap email>';
-- After that, admins promote each other through /admin/users/:id.

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "role" "Role" NOT NULL DEFAULT 'USER';

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");
