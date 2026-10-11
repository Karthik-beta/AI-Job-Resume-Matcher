import { InjectQueue } from "@nestjs/bullmq";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Queue } from "bullmq";
import { config } from "../config";
import { PrismaService } from "../prisma/prisma.service";
import { createRun } from "./create-run";
import { type RunJob, runsQueue } from "./runs.queue";

const recentRuns = 20;

@Injectable()
export class RunsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(runsQueue) private readonly queue: Queue<RunJob>,
  ) {}

  list(userId: string) {
    return this.prisma.run.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: recentRuns,
    });
  }

  async get(userId: string, id: string) {
    const run = await this.prisma.run.findFirst({
      where: { id, userId },
      include: { results: { orderBy: { createdAt: "asc" } } },
    });
    if (!run) throw new NotFoundException("Run not found");
    return run;
  }

  async start(userId: string, sourceIds: readonly string[]) {
    const created = await createRun(this.prisma, {
      userId,
      sourceIds,
      trigger: "MANUAL",
      model: config.OPENROUTER_MODEL,
    });
    switch (created._tag) {
      case "NoResume":
        throw new BadRequestException("Add a resume URL in settings before starting a run");
      case "SourceNotFound":
        throw new BadRequestException("Source not found");
      case "AlreadyActive":
        throw new ConflictException("A run is already in progress");
    }
    const { run } = created;

    try {
      await this.queue.add("run", { runId: run.id }, { jobId: run.id, attempts: 1 });
    } catch {
      // Without this the QUEUED row would block every later start with a 409.
      await this.prisma.run.update({
        where: { id: run.id },
        data: { status: "FAILED", stopReason: "Could not queue the run", finishedAt: new Date() },
      });
      throw new ServiceUnavailableException("Could not queue the run. Try again shortly.");
    }
    return run;
  }
}
