import type { MatchStatus } from "@job-matcher/shared";
import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

const pageSize = 20;

@Injectable()
export class MatchesService {
  constructor(private readonly prisma: PrismaService) {}

  // Newest first. The id breaks ties, so the order is stable across pages.
  async list(userId: string, status: MatchStatus | undefined, cursor: string | undefined) {
    const matches = await this.prisma.match.findMany({
      where: { userId, ...(status && { status }) },
      orderBy: [{ matchedAt: "desc" }, { id: "desc" }],
      take: pageSize + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
    });
    const items = matches.slice(0, pageSize);
    return { items, nextCursor: matches.length > pageSize ? (items.at(-1)?.id ?? null) : null };
  }

  async setStatus(userId: string, id: string, status: MatchStatus) {
    const { count } = await this.prisma.match.updateMany({
      where: { id, userId },
      data: { status },
    });
    if (count === 0) throw new NotFoundException("Match not found");
    return this.prisma.match.findUniqueOrThrow({ where: { id } });
  }
}
