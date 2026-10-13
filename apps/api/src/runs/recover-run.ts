import type { Queue } from "bullmq";
import type { PrismaClient } from "../generated/prisma/client";

export const interruptedReason =
  "The run was interrupted when its worker stopped. Results saved so far are kept; start a new run to check the rest.";

export const lostJobReason = "The run was never picked up. Start a new run.";

// A QUEUED run is saved before its job is added, so a run younger than this may still be getting
// its job and is left alone.
export const queueGraceMs = 60_000;

// Ends a run that lost its job, unless it has already ended. Its saved results are kept, and the
// next run in the same context skips them.
export const failActiveRun = (prisma: PrismaClient, runId: string, reason = interruptedReason) =>
  prisma.run.updateMany({
    where: { id: runId, status: { in: ["QUEUED", "RUNNING"] } },
    data: { status: "FAILED", stopReason: reason, finishedAt: new Date() },
  });

// An active run whose job BullMQ no longer holds, or holds as finished, is never delivered again,
// so it would block every later run. A QUEUED run loses its job when the API stops before adding
// it, or when Redis drops it. Jobs still active or waiting are left to stall recovery.
export const recoverOrphanedRuns = async (
  queue: Queue,
  prisma: PrismaClient,
  options: { readonly userId?: string; readonly now?: Date } = {},
) => {
  const queuedBefore = new Date((options.now ?? new Date()).getTime() - queueGraceMs);
  const active = await prisma.run.findMany({
    where: {
      ...(options.userId ? { userId: options.userId } : {}),
      OR: [{ status: "RUNNING" }, { status: "QUEUED", createdAt: { lt: queuedBefore } }],
    },
    select: { id: true, status: true },
  });
  const ended = await Promise.all(
    active.map(async ({ id, status }) => {
      const job = await queue.getJob(id);
      const state = job ? await job.getState() : "unknown";
      if (state !== "completed" && state !== "failed" && state !== "unknown") return 0;
      const reason = status === "QUEUED" ? lostJobReason : interruptedReason;
      return (await failActiveRun(prisma, id, reason)).count;
    }),
  );
  return ended.reduce((sum, count) => sum + count, 0);
};
