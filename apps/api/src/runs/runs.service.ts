import { InjectQueue } from "@nestjs/bullmq";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Queue } from "bullmq";
import { config } from "../config";
import { contextKey } from "../matching/context-key";
import { PrismaService } from "../prisma/prisma.service";
import { type RunJob, runsQueue } from "./runs.queue";

@Injectable()
export class RunsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(runsQueue) private readonly queue: Queue<RunJob>,
  ) {}

  async start(userId: string, sourceIds: readonly string[]) {
    const ids = [...new Set(sourceIds)];
    const run = await this.prisma.$transaction(async (tx) => {
      // Serialises starts per user, so two quick requests cannot both pass the active-run check.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;

      const settings = await tx.settings.findUnique({ where: { userId } });
      if (!settings?.resumeUrl) {
        throw new BadRequestException("Add a resume URL in settings before starting a run");
      }
      const owned = await tx.jobSource.count({ where: { userId, id: { in: ids } } });
      if (owned !== ids.length) throw new BadRequestException("Source not found");

      const active = await tx.run.findFirst({
        where: { userId, status: { in: ["QUEUED", "RUNNING"] } },
        select: { id: true },
      });
      if (active) throw new ConflictException("A run is already in progress");

      return tx.run.create({
        data: {
          userId,
          trigger: "MANUAL",
          sourceIds: ids,
          contextKey: contextKey({
            resumeUrl: settings.resumeUrl,
            sourceIds: ids,
            model: config.OPENROUTER_MODEL,
            requirements: {
              experienceYears: settings.experienceYears,
              experienceMonths: settings.experienceMonths,
              jobMinYears: settings.targetMinYears,
              jobMaxYears: settings.targetMaxYears,
              locations: settings.locations,
              includeUnknown: settings.includeUnknown,
            },
          }),
        },
      });
    });

    try {
      await this.queue.add("run", { runId: run.id }, { jobId: run.id });
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
