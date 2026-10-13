-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "onboardingCompletedAt" TIMESTAMP(3),
ADD COLUMN     "onboardingDismissedAt" TIMESTAMP(3);

-- Backfill: anyone who has started a run is past onboarding. Settings rows are created lazily,
-- so a user without one gets the same row the API would create (the column defaults, and an
-- empty locations list). apps/api/test/onboarding-backfill.test.ts runs this statement.
INSERT INTO "Settings" ("userId", "locations", "onboardingCompletedAt")
SELECT DISTINCT "userId", ARRAY[]::TEXT[], CURRENT_TIMESTAMP FROM "Run"
ON CONFLICT ("userId") DO UPDATE SET "onboardingCompletedAt" = EXCLUDED."onboardingCompletedAt"
WHERE "Settings"."onboardingCompletedAt" IS NULL;
