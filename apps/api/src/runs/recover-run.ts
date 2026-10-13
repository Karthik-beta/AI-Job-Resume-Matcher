import type { Queue } from "bullmq";
import type { PrismaClient } from "../generated/prisma/client";

export const interruptedReason =
  "The run was interrupted when its worker stopped. Results saved so far are kept; start a new run to check the rest.";

// Ends a run that lost its job, unless it has already ended. Its saved results are kept, and the
// next run in the same context skips them.
export const failActiveRun = (prisma: PrismaClient, runId: string, reason = interruptedReason) =>
  prisma.run.updateMany({
    where: { id: runId, status: { in: ["QUEUED", "RUNNING"] } },
    data: { status: "FAILED", stopReason: reason, finishedAt: new Date() },
  });

// A RUNNING run whose job BullMQ no longer holds, or holds as finished, is never delivered again,
// so it would block every later run. Jobs still active or waiting are left to stall recovery.
export const recoverOrphanedRuns = async (queue: Queue, prisma: PrismaClient) => {
  const running = await prisma.run.findMany({ where: { status: "RUNNING" }, select: { id: true } });
  const ended = await Promise.all(
    running.map(async ({ id }) => {
      const job = await queue.getJob(id);
      const state = job ? await job.getState() : "unknown";
      if (state !== "completed" && state !== "failed" && state !== "unknown") return 0;
      return (await failActiveRun(prisma, id)).count;
    }),
  );
  return ended.reduce((sum, count) => sum + count, 0);
};
