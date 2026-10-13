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
import { MatchAlerts } from "./match-alerts";
import { recoverOrphanedRuns } from "./recover-run";
import { runPageUrl } from "./run-page-url";
import { type RunJob, runsQueue, type ScheduledJob } from "./runs.queue";
import { upsertMatch } from "./save-match";
import { enqueueRun } from "./schedule";

const recentRuns = 20;
// How long a start waits to end a run that lost its job before answering that one is active.
export const recoveryTimeoutMs = 2_000;

@Injectable()
export class RunsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: MatchAlerts,
    @InjectQueue(runsQueue) private readonly queue: Queue<RunJob | ScheduledJob>,
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
    const { saved, updated } = await this.prisma.$transaction(async (tx) => {
      // Only the request that flips the flag adjusts the counter, so two quick retries count once.
      const { count } = await tx.jobResult.updateMany({
        where: { id: result.id, matchSaved: false },
        data: { matchSaved: true },
      });
      if (count === 1) {
        await tx.run.update({ where: { id: runId }, data: { failed: { decrement: 1 } } });
      }
      return {
        saved: count === 1,
        updated: await tx.jobResult.findUniqueOrThrow({ where: { id: result.id } }),
      };
    });

    // The alert processRun would have sent, had the first save worked. Sent once, by the same
    // request that adjusted the counter.
    if (saved) {
      const settings = await this.prisma.settings.findUnique({ where: { userId } });
      if (settings?.discordWebhookUrl) {
        await this.alerts.send(settings.discordWebhookUrl, {
          title: result.title,
          company: result.company,
          jobUrl: result.jobUrl,
          reason: result.reason ?? "",
          runUrl: runPageUrl(runId),
        });
      }
    }
    return updated;
  }

  async start(userId: string, sourceIds: readonly string[]) {
    const create = () =>
      createRun(this.prisma, {
        userId,
        sourceIds,
        trigger: "MANUAL",
        model: config.OPENROUTER_MODEL,
      });
    let created = await create();
    // The active run may be one that lost its job. If ending it frees the user, start again.
    if (created._tag === "AlreadyActive" && (await this.recoverLostRuns(userId)) > 0) {
      created = await create();
    }
    switch (created._tag) {
      case "NoResume":
        throw new BadRequestException("Add a resume URL in settings before starting a run");
      case "SourceNotFound":
        throw new BadRequestException("Source not found");
      case "AlreadyActive":
        throw new ConflictException("A run is already in progress");
    }
    const { run } = created;

    if (!(await enqueueRun(this.queue, this.prisma, run.id))) {
      throw new ServiceUnavailableException("Could not queue the run. Try again shortly.");
    }
    return run;
  }

  // Best effort and bounded: the queue's connection waits for Redis instead of failing, so an
  // outage would otherwise hold the request.
  private async recoverLostRuns(userId: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<number>((resolve) => {
      timer = setTimeout(() => resolve(0), recoveryTimeoutMs);
    });
    try {
      return await Promise.race([
        recoverOrphanedRuns(this.queue, this.prisma, { userId }).catch(() => 0),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
