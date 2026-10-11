import type { MatchStatus } from "@job-matcher/shared";
import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class MatchesService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string, status: MatchStatus | undefined) {
    return this.prisma.match.findMany({
      where: { userId, ...(status && { status }) },
      orderBy: { matchedAt: "desc" },
    });
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
