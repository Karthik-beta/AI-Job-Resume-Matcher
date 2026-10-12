-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('GREENHOUSE', 'LEVER', 'ASHBY', 'SMARTRECRUITERS', 'RECRUITEE', 'SEARCH', 'PAGE');

-- AlterTable
ALTER TABLE "JobSource" ADD COLUMN     "adapterKey" TEXT,
ADD COLUMN     "kind" "SourceKind" NOT NULL DEFAULT 'PAGE',
ADD COLUMN     "listingHash" TEXT,
ADD COLUMN     "maxPages" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "query" TEXT,
ADD COLUMN     "selector" TEXT;

-- Backfill: sources on a supported ATS host read its public API (mirrors detectSource).
UPDATE "JobSource" SET "kind" = 'GREENHOUSE', "adapterKey" = substring("url" from '(?i)^https?://(?:job-)?boards\.(?:[a-z0-9-]+\.)?greenhouse\.io/embed/job_board(?:/js)?/?\?(?:[^#]*&)?for=([A-Za-z0-9][A-Za-z0-9_.-]*)')
WHERE "kind" = 'PAGE' AND "url" ~* '^https?://(?:job-)?boards\.(?:[a-z0-9-]+\.)?greenhouse\.io/embed/job_board(?:/js)?/?\?(?:[^#]*&)?for=[A-Za-z0-9]';

UPDATE "JobSource" SET "kind" = 'GREENHOUSE', "adapterKey" = substring("url" from '(?i)^https?://boards-api\.(?:eu\.)?greenhouse\.io/v1/boards/([A-Za-z0-9][A-Za-z0-9_.-]*)')
WHERE "kind" = 'PAGE' AND "url" ~* '^https?://boards-api\.(?:eu\.)?greenhouse\.io/v1/boards/[A-Za-z0-9]';

UPDATE "JobSource" SET "kind" = 'GREENHOUSE', "adapterKey" = substring("url" from '(?i)^https?://(?:job-)?boards\.(?:[a-z0-9-]+\.)?greenhouse\.io/([A-Za-z0-9][A-Za-z0-9_.-]*)')
WHERE "kind" = 'PAGE' AND "url" ~* '^https?://(?:job-)?boards\.(?:[a-z0-9-]+\.)?greenhouse\.io/(?!embed(?:[/?#]|$))[A-Za-z0-9]';

UPDATE "JobSource" SET "kind" = 'LEVER', "adapterKey" = substring("url" from '(?i)^https?://jobs\.(?:eu\.)?lever\.co/([A-Za-z0-9][A-Za-z0-9_.-]*)')
WHERE "kind" = 'PAGE' AND "url" ~* '^https?://jobs\.(?:eu\.)?lever\.co/[A-Za-z0-9]';

UPDATE "JobSource" SET "kind" = 'ASHBY', "adapterKey" = substring("url" from '(?i)^https?://jobs\.ashbyhq\.com/([A-Za-z0-9][A-Za-z0-9_.-]*)')
WHERE "kind" = 'PAGE' AND "url" ~* '^https?://jobs\.ashbyhq\.com/(?!(?:api|b|embed|meeting)(?:[/?#]|$))[A-Za-z0-9]';

UPDATE "JobSource" SET "kind" = 'SMARTRECRUITERS', "adapterKey" = substring("url" from '(?i)^https?://(?:jobs|careers)\.smartrecruiters\.com/([A-Za-z0-9][A-Za-z0-9_.-]*)')
WHERE "kind" = 'PAGE' AND "url" ~* '^https?://(?:jobs|careers)\.smartrecruiters\.com/(?!external-referrals(?:[/?#]|$))[A-Za-z0-9]';

UPDATE "JobSource" SET "kind" = 'RECRUITEE', "adapterKey" = lower(substring("url" from '(?i)^https?://([a-z0-9-]+)\.recruitee\.com(?:[/?#:]|$)'))
WHERE "kind" = 'PAGE' AND "url" ~* '^https?://(?!(?:api|app|blog|docs|help|support|www)\.)[a-z0-9-]+\.recruitee\.com(?:[/?#:]|$)';
