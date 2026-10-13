-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "onboardingCompletedAt" TIMESTAMP(3),
ADD COLUMN     "onboardingDismissedAt" TIMESTAMP(3);

-- Backfill: anyone who has started a run is past onboarding. Settings rows are created lazily,
-- so a user without one gets the same row the API would create (the column defaults, and an
-- empty locations list). "Run"."userId" has no foreign key, so runs left by deleted users are
-- skipped. apps/api/test/onboarding-backfill.test.ts runs this statement.
INSERT INTO "Settings" ("userId", "locations", "onboardingCompletedAt")
SELECT DISTINCT r."userId", ARRAY[]::TEXT[], CURRENT_TIMESTAMP FROM "Run" r
WHERE EXISTS (SELECT 1 FROM "user" u WHERE u."id" = r."userId")
ON CONFLICT ("userId") DO UPDATE SET "onboardingCompletedAt" = EXCLUDED."onboardingCompletedAt"
WHERE "Settings"."onboardingCompletedAt" IS NULL;
