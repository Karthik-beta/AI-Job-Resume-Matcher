import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class SourcesService {
  constructor(private readonly prisma: PrismaService) {}

  list(userId: string) {
    return this.prisma.jobSource.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  }

  async create(userId: string, url: string) {
    try {
      return await this.prisma.jobSource.create({ data: { userId, url } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("This source is already added");
      }
      throw error;
    }
  }

  async remove(userId: string, id: string) {
    const { count } = await this.prisma.jobSource.deleteMany({ where: { id, userId } });
    if (count === 0) throw new NotFoundException("Source not found");
  }
}
