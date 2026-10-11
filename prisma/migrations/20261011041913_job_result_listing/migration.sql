-- AlterTable
ALTER TABLE "JobResult" ADD COLUMN     "expMaxYears" DOUBLE PRECISION,
ADD COLUMN     "expMinYears" DOUBLE PRECISION,
ADD COLUMN     "locations" TEXT[];
