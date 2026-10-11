import type { PrismaClient } from "../generated/prisma/client";

export interface MatchFields {
  readonly jobUrl: string;
  readonly title: string;
  readonly company: string;
  readonly locations: readonly string[];
  readonly expMinYears: number | null;
  readonly expMaxYears: number | null;
  readonly reason: string;
}

// A match found again keeps its application status.
export const upsertMatch = (prisma: PrismaClient, userId: string, match: MatchFields) =>
  prisma.match.upsert({
    where: { userId_jobUrl: { userId, jobUrl: match.jobUrl } },
    create: { userId, ...match, locations: [...match.locations] },
    update: { reason: match.reason, matchedAt: new Date() },
  });
