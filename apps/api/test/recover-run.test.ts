import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Job, Queue } from "bullmq";
import type { RunStatus } from "../src/generated/prisma/client";
import { PrismaService } from "../src/prisma/prisma.service";
import { createRun } from "../src/runs/create-run";
import { failActiveRun, interruptedReason, recoverOrphanedRuns } from "../src/runs/recover-run";
import { RunsProcessor } from "../src/runs/runs.processor";
import type { RunJob } from "../src/runs/runs.queue";
import type { EffectRuntime } from "../src/worker/effect-runtime";

describe("interrupted runs", () => {
  const prisma = new PrismaService();
  const userId = `test-${crypto.randomUUID()}`;
  let sourceId: string;
  const runIds = new Set<string>();

  const addRun = async (status: RunStatus) => {
    const run = await prisma.run.create({
      data: { userId, trigger: "MANUAL", contextKey: "test", sourceIds: [sourceId], status },
    });
    runIds.add(run.id);
    return run.id;
  };
  const runOf = (id: string) => prisma.run.findUniqueOrThrow({ where: { id } });

  // A queue holding this test's jobs in the given states; a test run without one has no job. Runs
  // from elsewhere in the shared database report active, so recovery leaves them alone.
  const queueWith = (states: Record<string, string>) =>
    ({
      getJob: (id: string) => {
        const state = runIds.has(id) ? states[id] : "active";
        return Promise.resolve(state ? { getState: () => Promise.resolve(state) } : undefined);
      },
    }) as unknown as Queue;

  beforeAll(async () => {
    await prisma.settings.create({ data: { userId, resumeUrl: "https://example.com/cv.pdf" } });
    const source = await prisma.jobSource.create({
      data: { userId, url: "https://board.example.com/a" },
    });
    sourceId = source.id;
  });

  afterAll(async () => {
    await prisma.run.deleteMany({ where: { userId } });
    await prisma.jobSource.deleteMany({ where: { userId } });
    await prisma.settings.deleteMany({ where: { userId } });
    await prisma.$disconnect();
  });

  it("does not change a run that has already ended", async () => {
    const runId = await addRun("COMPLETED");

    expect((await failActiveRun(prisma, runId)).count).toBe(0);
    expect(await runOf(runId)).toMatchObject({ status: "COMPLETED", stopReason: null });
  });

  it("ends RUNNING runs on startup whose job is gone or finished, and lets a new run start", async () => {
    const lost = await addRun("RUNNING");
    const failed = await addRun("RUNNING");
    const active = await addRun("RUNNING");
    const queue = queueWith({ [failed]: "failed", [active]: "active" });

    // Another worker still holds the active job, so starts stay refused.
    expect(await recoverOrphanedRuns(queue, prisma)).toBe(2);
    for (const id of [lost, failed]) {
      const run = await runOf(id);
      expect(run).toMatchObject({ status: "FAILED", stopReason: interruptedReason });
      expect(run.finishedAt).not.toBeNull();
    }
    expect((await runOf(active)).status).toBe("RUNNING");
    const options = { userId, sourceIds: [sourceId], trigger: "MANUAL", model: "m" } as const;
    expect((await createRun(prisma, options))._tag).toBe("AlreadyActive");

    await recoverOrphanedRuns(queueWith({}), prisma);
    expect((await createRun(prisma, options))._tag).toBe("Created");
  });

  describe("when BullMQ fails a run's job", () => {
    const processor = new RunsProcessor(prisma, {} as EffectRuntime, {} as Queue);
    const fail = (runId: string, message: string, stalledCounter = 0) =>
      processor.onFailed({ data: { runId }, stalledCounter } as Job<RunJob>, new Error(message));

    it("ends a run whose job stalled too often as interrupted", async () => {
      const runId = await addRun("RUNNING");
      await fail(runId, "job stalled more than allowable limit", 2);

      expect(await runOf(runId)).toMatchObject({ status: "FAILED", stopReason: interruptedReason });
    });

    it("ends a run whose job failed for another reason", async () => {
      const runId = await addRun("QUEUED");
      await fail(runId, "Connection lost");

      expect(await runOf(runId)).toMatchObject({
        status: "FAILED",
        stopReason: "The run failed unexpectedly",
      });
    });

    it("keeps the reason of a run that already ended", async () => {
      const runId = await addRun("RUNNING");
      await prisma.run.update({
        where: { id: runId },
        data: { status: "STOPPED", stopReason: "User not found." },
      });
      await fail(runId, "job stalled more than allowable limit", 2);

      expect(await runOf(runId)).toMatchObject({
        status: "STOPPED",
        stopReason: "User not found.",
      });
    });

    it("logs instead of throwing when the run cannot be ended", async () => {
      const down = {
        run: { updateMany: () => Promise.reject(new Error("Database is down")) },
      } as unknown as PrismaService;
      const offline = new RunsProcessor(down, {} as EffectRuntime, {} as Queue);
      const job = { data: { runId: "missing" }, stalledCounter: 2 } as Job<RunJob>;

      await expect(offline.onFailed(job, new Error("stalled"))).resolves.toBeUndefined();
    });
  });
});
