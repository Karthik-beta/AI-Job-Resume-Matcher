import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import type { OnApplicationBootstrap } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import { config } from "../config";
import { PrismaService } from "../prisma/prisma.service";
import { EffectRuntime } from "../worker/effect-runtime";
import { createScheduledRun } from "./create-run";
import { processRun } from "./process-run";
import { type RunJob, runsQueue, type ScheduledJob } from "./runs.queue";
import { enqueueRun, syncSchedule } from "./schedule";

// One run at a time, so runs share the Firecrawl rate limit in order.
@Processor(runsQueue, { concurrency: 1 })
export class RunsProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly prisma: PrismaService,
    private readonly effect: EffectRuntime,
    @InjectQueue(runsQueue) private readonly queue: Queue<RunJob | ScheduledJob>,
  ) {
    super();
  }

  // Restores schedulers from settings, in case a save stored the schedule but Redis was down.
  async onApplicationBootstrap() {
    const scheduled = await this.prisma.settings.findMany({
      where: { scheduleMinutes: { not: null } },
      select: { userId: true, scheduleMinutes: true },
    });
    for (const { userId, scheduleMinutes } of scheduled) {
      await syncSchedule(this.queue, userId, scheduleMinutes);
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
    // It is skipped while a run is active or before the user has a resume and sources.
    const run = await createScheduledRun(this.prisma, userId, config.OPENROUTER_MODEL);
    if (run) await enqueueRun(this.queue, this.prisma, run.id);
  }
}
