-- CreateEnum
CREATE TYPE "ScrapeVia" AS ENUM ('ATS', 'CACHE', 'LOCAL', 'CLOUD');

-- AlterTable
ALTER TABLE "JobResult" ADD COLUMN     "scrapedVia" "ScrapeVia";

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "cloudCredits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cloudCreditsAtStart" INTEGER;
