import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { config } from "../config";
import { PrismaService } from "../prisma/prisma.service";
import { EffectRuntime } from "../worker/effect-runtime";
import { createScheduledRun } from "./create-run";
import { processRun } from "./process-run";
import { type RunJob, runsQueue, type ScheduledJob } from "./runs.queue";

// One run at a time, so runs share the Firecrawl rate limit in order.
@Processor(runsQueue, { concurrency: 1 })
export class RunsProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly effect: EffectRuntime,
  ) {
    super();
  }

  async process(job: Job<RunJob | ScheduledJob>) {
    if ("runId" in job.data) return this.run(job.data.runId);
    const run = await createScheduledRun(this.prisma, job.data.userId, config.OPENROUTER_MODEL);
    // A tick is skipped while a run is active or before the user has a resume and sources.
    if (run) return this.run(run.id);
  }

  private run(runId: string) {
    return this.effect.runPromise(processRun(this.prisma, runId));
  }
}
