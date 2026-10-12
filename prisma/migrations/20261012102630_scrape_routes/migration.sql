-- CreateTable
CREATE TABLE "ScrapeRoute" (
    "domain" TEXT NOT NULL,
    "localBlocks" INTEGER NOT NULL DEFAULT 0,
    "preferCloudUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScrapeRoute_pkey" PRIMARY KEY ("domain")
);
