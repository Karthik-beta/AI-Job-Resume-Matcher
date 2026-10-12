import type { UpdateJobSource } from "@job-matcher/shared";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "../generated/prisma/client";
import { detectSource } from "../matching/sources/detect";
import { searchSourceUrl } from "../matching/sources/search";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class SourcesService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string) {
    return this.prisma.jobSource.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  }

  create(userId: string, url: string) {
    return this.added(
      this.prisma.jobSource.create({ data: { userId, url, ...detectSource(url) } }),
      "This source is already added",
    );
  }

  // Stored under a synthetic URL (see searchSourceUrl), so the same query is added once.
  createSearch(userId: string, rawQuery: string) {
    const query = rawQuery.replace(/\s+/g, " ");
    return this.added(
      this.prisma.jobSource.create({
        data: { userId, url: searchSourceUrl(query), kind: "SEARCH", query },
      }),
      "This search is already added",
    );
  }

  private async added<A>(create: Promise<A>, duplicate: string) {
    try {
      return await create;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException(duplicate);
      }
      throw error;
    }
  }

  async update(userId: string, id: string, { kind, adapterKey, useMap }: UpdateJobSource) {
    const source = await this.prisma.jobSource.findFirst({ where: { id, userId } });
    if (!source) throw new NotFoundException("Source not found");
    if (source.kind === "SEARCH") {
      throw new BadRequestException("A search source cannot be switched to another type");
    }
    const [updated] = await this.prisma.$transaction([
      this.prisma.jobSource.update({
        where: { id },
        // Choosing a kind settles any embedded-board suggestion.
        data: {
          kind,
          adapterKey: kind === "PAGE" ? null : adapterKey,
          suggestedKind: null,
          suggestedAdapterKey: null,
          listingHash: null,
          ...(useMap === undefined ? {} : { useMap }),
        },
      }),
      // Cached listings came from the previous kind or way of reading the page.
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
