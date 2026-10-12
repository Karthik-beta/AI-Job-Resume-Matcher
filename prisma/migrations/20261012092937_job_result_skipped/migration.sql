-- CreateEnum
CREATE TYPE "SkipReason" AS ENUM ('EXPIRED', 'TRIAGE');

-- AlterTable
ALTER TABLE "JobResult" ADD COLUMN     "skipped" "SkipReason";
