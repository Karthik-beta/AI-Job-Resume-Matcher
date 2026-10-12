import type { UpdateJobSource } from "@job-matcher/shared";
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client";
import { detectSource } from "../matching/sources/detect";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class SourcesService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string) {
    return this.prisma.jobSource.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  }

  async create(userId: string, url: string) {
    try {
      return await this.prisma.jobSource.create({ data: { userId, url, ...detectSource(url) } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("This source is already added");
      }
      throw error;
    }
  }

  async update(userId: string, id: string, { kind, adapterKey }: UpdateJobSource) {
    const source = await this.prisma.jobSource.findFirst({ where: { id, userId } });
    if (!source) throw new NotFoundException("Source not found");
    const [updated] = await this.prisma.$transaction([
      this.prisma.jobSource.update({
        where: { id },
        // Choosing a kind settles any embedded-board suggestion.
        data: {
          kind,
          adapterKey: kind === "PAGE" ? null : adapterKey,
          suggestedKind: null,
          suggestedAdapterKey: null,
        },
      }),
      // Cached listings came from the previous kind.
      this.prisma.pageCache.deleteMany({
        where: { userId, url: source.url, kind: "SOURCE_LISTING" },
      }),
    ]);
    return updated;
  }

  async remove(userId: string, id: string) {
    const { count } = await this.prisma.jobSource.deleteMany({ where: { id, userId } });
    if (count === 0) throw new NotFoundException("Source not found");
  }
}
