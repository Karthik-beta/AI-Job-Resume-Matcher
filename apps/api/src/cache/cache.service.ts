import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class CacheService {
  constructor(private readonly prisma: PrismaService) {}

  async clear(userId: string) {
    const { count } = await this.prisma.pageCache.deleteMany({ where: { userId } });
    return { deleted: count };
  }
}
