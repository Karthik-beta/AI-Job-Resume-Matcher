-- AlterTable
ALTER TABLE "Settings" ADD COLUMN     "titleExclude" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "titleInclude" TEXT[] DEFAULT ARRAY[]::TEXT[];
