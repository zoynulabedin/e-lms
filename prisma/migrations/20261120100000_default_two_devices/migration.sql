-- Two devices per learner by default (client acceptance requirement; the
-- default was 1, so every account was limited to a single device).

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "maxDevices" SET DEFAULT 2;

-- Accounts still on the old default move to the new one. 0 (unlimited) and
-- any other value an admin chose on the Users page are left alone. (A value of
-- exactly 1 cannot be told apart from the old default, so it moves to 2 too.)
UPDATE "User" SET "maxDevices" = 2 WHERE "maxDevices" = 1;
