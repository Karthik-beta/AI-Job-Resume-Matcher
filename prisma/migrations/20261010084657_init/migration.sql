-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'STOPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "RunTrigger" AS ENUM ('MANUAL', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('PENDING', 'APPLIED');

-- CreateEnum
CREATE TYPE "CacheKind" AS ENUM ('RESUME', 'JOB_PAGE', 'SOURCE_LISTING');

-- CreateTable
CREATE TABLE "Settings" (
    "userId" TEXT NOT NULL,
    "resumeUrl" TEXT,
    "discordWebhookUrl" TEXT,
    "experienceYears" INTEGER NOT NULL DEFAULT 0,
    "experienceMonths" INTEGER NOT NULL DEFAULT 0,
    "targetMinYears" DOUBLE PRECISION,
    "targetMaxYears" DOUBLE PRECISION,
    "locations" TEXT[],
    "includeUnknown" BOOLEAN NOT NULL DEFAULT true,
    "maxJobsPerRun" INTEGER NOT NULL DEFAULT 5,
    "scheduleMinutes" INTEGER,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "JobSource" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trigger" "RunTrigger" NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'QUEUED',
    "contextKey" TEXT NOT NULL,
    "sourceIds" TEXT[],
    "found" INTEGER NOT NULL DEFAULT 0,
    "eligible" INTEGER NOT NULL DEFAULT 0,
    "checked" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "stopReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contextKey" TEXT NOT NULL,
    "jobUrl" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "isMatch" BOOLEAN,
    "reason" TEXT,
    "error" TEXT,
    "matchSaved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobUrl" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "locations" TEXT[],
    "expMinYears" DOUBLE PRECISION,
    "expMaxYears" DOUBLE PRECISION,
    "reason" TEXT NOT NULL,
    "status" "MatchStatus" NOT NULL DEFAULT 'PENDING',
    "matchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageCache" (
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "kind" "CacheKind" NOT NULL,
    "content" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageCache_pkey" PRIMARY KEY ("userId","url","kind")
);

-- CreateIndex
CREATE UNIQUE INDEX "JobSource_userId_url_key" ON "JobSource"("userId", "url");

-- CreateIndex
CREATE INDEX "Run_userId_createdAt_idx" ON "Run"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "JobResult_userId_contextKey_jobUrl_key" ON "JobResult"("userId", "contextKey", "jobUrl");

-- CreateIndex
CREATE UNIQUE INDEX "Match_userId_jobUrl_key" ON "Match"("userId", "jobUrl");

-- AddForeignKey
ALTER TABLE "JobResult" ADD CONSTRAINT "JobResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
