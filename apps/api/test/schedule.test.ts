import { afterAll, describe, expect, it } from "bun:test";
import type { Queue } from "bullmq";
import { PrismaService } from "../src/prisma/prisma.service";
import { enqueueRun } from "../src/runs/schedule";

describe("enqueueRun", () => {
  const prisma = new PrismaService();
  const userId = `test-${crypto.randomUUID()}`;

  afterAll(async () => {
    await prisma.run.deleteMany({ where: { userId } });
    await prisma.$disconnect();
  });

  it("marks the run FAILED when the queue rejects it", async () => {
    const run = await prisma.run.create({
      data: { userId, trigger: "SCHEDULED", contextKey: "test", sourceIds: [] },
    });
    const queue = {
      add: () => Promise.reject(new Error("Redis is down")),
    } as unknown as Queue;

    expect(await enqueueRun(queue, prisma, run.id)).toBe(false);
    const failed = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(failed).toMatchObject({ status: "FAILED", stopReason: "Could not queue the run" });
    expect(failed.finishedAt).not.toBeNull();
  });

  it("queues the run under its own id with a single attempt", async () => {
    const run = await prisma.run.create({
      data: { userId, trigger: "SCHEDULED", contextKey: "test", sourceIds: [] },
    });
    const added: unknown[][] = [];
    const queue = {
      add: (...args: unknown[]) => {
        added.push(args);
        return Promise.resolve();
      },
    } as unknown as Queue;

    expect(await enqueueRun(queue, prisma, run.id)).toBe(true);
    expect(added).toEqual([["run", { runId: run.id }, { jobId: run.id, attempts: 1 }]]);
    const queued = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(queued.status).toBe("QUEUED");
  });
});
