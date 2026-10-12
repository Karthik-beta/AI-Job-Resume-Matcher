import type { PrismaClient } from "../generated/prisma/client";
import { canonicalUrl } from "../matching/dedupe";

export interface MatchFields {
  readonly jobUrl: string;
  readonly title: string;
  readonly company: string;
  readonly locations: readonly string[];
  readonly expMinYears: number | null;
  readonly expMaxYears: number | null;
  readonly reason: string;
}

// A match saved before URLs were made canonical may be stored under another spelling of the
// same job page, so it is found by its canonical URL rather than saved a second time.
const existingMatchId = async (prisma: PrismaClient, userId: string, jobUrl: string) => {
  const canonical = canonicalUrl(jobUrl);
  const matches = await prisma.match.findMany({
    where: { userId },
    select: { id: true, jobUrl: true },
  });
  const existing =
    matches.find((match) => match.jobUrl === jobUrl) ??
    matches.find((match) => canonicalUrl(match.jobUrl) === canonical);
  return existing?.id ?? null;
};

// A match found again keeps its application status.
export const upsertMatch = async (prisma: PrismaClient, userId: string, match: MatchFields) => {
  const update = { reason: match.reason, matchedAt: new Date() };
  const id = await existingMatchId(prisma, userId, match.jobUrl);
  if (id !== null) return prisma.match.update({ where: { id }, data: update });
  return prisma.match.upsert({
    where: { userId_jobUrl: { userId, jobUrl: match.jobUrl } },
    create: { userId, ...match, locations: [...match.locations] },
    update,
  });
};
