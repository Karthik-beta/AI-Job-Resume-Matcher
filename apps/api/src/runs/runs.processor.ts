import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { PrismaService } from "../prisma/prisma.service";
import { EffectRuntime } from "../worker/effect-runtime";
import { processRun } from "./process-run";
import { type RunJob, runsQueue } from "./runs.queue";

// One run at a time, so runs share the Firecrawl rate limit in order.
@Processor(runsQueue, { concurrency: 1 })
export class RunsProcessor extends WorkerHost {
  constructor(
    private readonly prisma: PrismaService,
    private readonly effect: EffectRuntime,
  ) {
    super();
  }

  process(job: Job<RunJob>) {
    return this.effect.runPromise(processRun(this.prisma, job.data.runId));
  }
}
