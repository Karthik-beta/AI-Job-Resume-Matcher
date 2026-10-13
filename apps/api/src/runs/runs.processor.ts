import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger, type OnApplicationBootstrap } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import { config } from "../config";
import { PrismaService } from "../prisma/prisma.service";
import { EffectRuntime } from "../worker/effect-runtime";
import { createScheduledRun } from "./create-run";
import { processRun } from "./process-run";
import { failActiveRun, interruptedReason, recoverOrphanedRuns } from "./recover-run";
import { type RunJob, runsQueue, type ScheduledJob } from "./runs.queue";
import { enqueueRun, syncSchedule } from "./schedule";

// One run at a time, so runs share the Firecrawl rate limit in order.
@Processor(runsQueue, { concurrency: 1 })
export class RunsProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(RunsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly effect: EffectRuntime,
    @InjectQueue(runsQueue) private readonly queue: Queue<RunJob | ScheduledJob>,
  ) {
    super();
  }

  // Restores schedulers from settings, in case a save stored the schedule but Redis was down,
  // and ends runs a stopped worker left RUNNING without a job to recover them.
  async onApplicationBootstrap() {
    // Best effort: a failed check must not stop the worker or the schedules from starting.
    try {
      const recovered = await recoverOrphanedRuns(this.queue, this.prisma);
      if (recovered > 0) this.logger.warn(`Marked ${recovered} interrupted run(s) as failed`);
    } catch (error) {
      this.logger.error(`Could not check for interrupted runs: ${error}`);
    }
    const scheduled = await this.prisma.settings.findMany({
      where: { scheduleMinutes: { not: null } },
      select: { userId: true, scheduleMinutes: true },
    });
    for (const { userId, scheduleMinutes } of scheduled) {
      await syncSchedule(this.queue, userId, scheduleMinutes);
    }
  }

  // A run's job can fail without reaching processRun, such as when BullMQ fails a job that stalled
  // more than once. Its run is ended so it does not block later runs.
  @OnWorkerEvent("failed")
  async onFailed(job: Job<RunJob | ScheduledJob> | undefined, error: Error) {
    if (!job || !("runId" in job.data)) return;
    const reason = job.stalledCounter > 0 ? interruptedReason : "The run failed unexpectedly";
    // Event handlers are not awaited, so an error here would be an unhandled rejection.
    try {
      await failActiveRun(this.prisma, job.data.runId, reason);
    } catch (cause) {
      this.logger.error(
        `Could not end run ${job.data.runId} after its job failed (${error.message}): ${cause}`,
      );
    }
  }

  async process(job: Job<RunJob | ScheduledJob>) {
    if ("runId" in job.data) {
      return this.effect.runPromise(
        processRun(this.prisma, job.data.runId, config.OPENROUTER_MODEL),
      );
    }
    const { userId } = job.data;
    const settings = await this.prisma.settings.findUnique({ where: { userId } });
    if (!settings?.scheduleMinutes) {
      await syncSchedule(this.queue, userId, null);
      return;
    }
    // The tick queues an ordinary run job, so a run is never left QUEUED without a job.
    // It is skipped while a run is active or before the user has a resume and sources. A run that
    // lost its job is ended first, so it does not hold up the schedule.
    await recoverOrphanedRuns(this.queue, this.prisma, { userId });
    const run = await createScheduledRun(this.prisma, userId, config.OPENROUTER_MODEL);
    if (run) await enqueueRun(this.queue, this.prisma, run.id);
  }
}
