import type { Queue } from "bullmq";
import type { PrismaClient } from "../generated/prisma/client";
import { type RunJob, type ScheduledJob, scheduledJob, schedulerId } from "./runs.queue";

type RunsQueue = Queue<RunJob | ScheduledJob>;

export const syncSchedule = async (queue: RunsQueue, userId: string, minutes: number | null) => {
  if (minutes === null) {
    await queue.removeJobScheduler(schedulerId(userId));
    return;
  }
  await queue.upsertJobScheduler(
    schedulerId(userId),
    { every: minutes * 60_000 },
    {
      name: scheduledJob,
      data: { userId },
      opts: { attempts: 1, removeOnComplete: true, removeOnFail: 100 },
    },
  );
};

// A run that cannot be queued is marked FAILED, or its QUEUED row would block every later start.
export const enqueueRun = async (queue: RunsQueue, prisma: PrismaClient, runId: string) => {
  try {
    await queue.add("run", { runId }, { jobId: runId, attempts: 1 });
    return true;
  } catch {
    await prisma.run.update({
      where: { id: runId },
      data: { status: "FAILED", stopReason: "Could not queue the run", finishedAt: new Date() },
    });
    return false;
  }
};
