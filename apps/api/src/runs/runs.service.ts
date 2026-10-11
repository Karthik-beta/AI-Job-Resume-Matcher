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
import { contextKey } from "../matching/context-key";
import { PrismaService } from "../prisma/prisma.service";
import { requirementsOf } from "./run-settings";
import { type RunJob, runsQueue } from "./runs.queue";
import { upsertMatch } from "./save-match";

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

  // Saves a match whose first save failed, without scraping or evaluating the job again.
  async retrySave(userId: string, runId: string, resultId: string) {
    const result = await this.prisma.jobResult.findFirst({
      where: { id: resultId, runId, userId },
    });
    if (!result) throw new NotFoundException("Result not found");
    if (result.isMatch !== true) throw new ConflictException("Only a match can be saved");
    if (result.matchSaved) return result;

    await upsertMatch(this.prisma, userId, {
      jobUrl: result.jobUrl,
      title: result.title,
      company: result.company,
      locations: result.locations,
      expMinYears: result.expMinYears,
      expMaxYears: result.expMaxYears,
      reason: result.reason ?? "",
    });
    return this.prisma.$transaction(async (tx) => {
      // Only the request that flips the flag adjusts the counter, so two quick retries count once.
      const { count } = await tx.jobResult.updateMany({
        where: { id: result.id, matchSaved: false },
        data: { matchSaved: true },
      });
      if (count === 1) {
        await tx.run.update({ where: { id: runId }, data: { failed: { decrement: 1 } } });
      }
      return tx.jobResult.findUniqueOrThrow({ where: { id: result.id } });
    });
  }

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
            requirements: requirementsOf(settings),
          }),
        },
      });
    });

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
