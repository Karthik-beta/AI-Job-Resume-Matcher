import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { Job, Queue } from "bullmq";
import { Effect } from "effect";
import { PrismaService } from "../src/prisma/prisma.service";
import { RunsProcessor } from "../src/runs/runs.processor";
import type { RunJob, ScheduledJob } from "../src/runs/runs.queue";
import { EffectRuntime } from "../src/worker/effect-runtime";

// A queue that records the calls the processor makes; its run jobs are in the given states.
const recordingQueue = (states: Record<string, string> = {}) => {
  const calls: unknown[][] = [];
  const queue = {
    getJob: (id: string) =>
      Promise.resolve(states[id] ? { getState: () => Promise.resolve(states[id]) } : undefined),
    upsertJobScheduler: (...args: unknown[]) => Promise.resolve(calls.push(["upsert", ...args])),
    removeJobScheduler: (...args: unknown[]) => Promise.resolve(calls.push(["remove", ...args])),
    add: (...args: unknown[]) => Promise.resolve(calls.push(["add", ...args])),
  } as unknown as Queue;
  return { queue, calls };
};

const noEffects = {} as EffectRuntime;

describe("runs processor", () => {
  const prisma = new PrismaService();
  const userId = `test-${crypto.randomUUID()}`;
  const scheduledJobFor = (id: string) => ({ data: { userId: id } }) as Job<ScheduledJob>;

  beforeAll(async () => {
    await prisma.settings.create({
      data: { userId, resumeUrl: "https://example.com/cv.pdf", scheduleMinutes: 60 },
    });
    await prisma.jobSource.create({ data: { userId, url: "https://board.example.com/a" } });
  });

  afterAll(async () => {
    await prisma.run.deleteMany({ where: { userId } });
    await prisma.jobSource.deleteMany({ where: { userId } });
    await prisma.settings.deleteMany({ where: { userId } });
    await prisma.$disconnect();
  });

  describe("on startup", () => {
    // Other test files share the database, so startup reads a stand-in for it.
    const database = (runs: Promise<{ id: string }[]>) => {
      const ended: string[] = [];
      const fake = {
        run: {
          findMany: () => runs,
          updateMany: ({ where }: { where: { id: string } }) => {
            ended.push(where.id);
            return Promise.resolve({ count: 1 });
          },
        },
        settings: {
          findMany: () => Promise.resolve([{ userId: "scheduled-user", scheduleMinutes: 30 }]),
        },
      } as unknown as PrismaService;
      return { fake, ended };
    };

    it("ends runs left without a job and restores schedules", async () => {
      const { fake, ended } = database(Promise.resolve([{ id: "orphan" }, { id: "active" }]));
      const { queue, calls } = recordingQueue({ active: "active" });

      await new RunsProcessor(fake, noEffects, queue).onApplicationBootstrap();

      expect(ended).toEqual(["orphan"]);
      expect(calls).toEqual([
        [
          "upsert",
          "user:scheduled-user",
          { every: 30 * 60_000 },
          expect.objectContaining({ data: { userId: "scheduled-user" } }),
        ],
      ]);
    });

    it("still restores schedules when the check for interrupted runs fails", async () => {
      const { fake, ended } = database(Promise.reject(new Error("Database is busy")));
      const { queue, calls } = recordingQueue();

      await new RunsProcessor(fake, noEffects, queue).onApplicationBootstrap();

      expect(ended).toEqual([]);
      expect(calls.map(([call]) => call)).toEqual(["upsert"]);
    });
  });

  it("ignores a failed job that is not a run", async () => {
    const { queue } = recordingQueue();
    const processor = new RunsProcessor(prisma, noEffects, queue);

    await processor.onFailed(undefined, new Error("Missing"));
    await processor.onFailed(scheduledJobFor(userId), new Error("Failed"));
    expect(await prisma.run.count({ where: { userId } })).toBe(0);
  });

  it("processes a run job in the Effect runtime", async () => {
    // A user without settings, so the run stops as soon as it is processed.
    const noResume = `test-${crypto.randomUUID()}`;
    const { id } = await prisma.run.create({
      data: { userId: noResume, trigger: "MANUAL", contextKey: "test", sourceIds: [] },
    });
    const effect = new EffectRuntime(prisma);
    await effect.onModuleInit();
    try {
      const { queue } = recordingQueue();
      await new RunsProcessor(prisma, effect, queue).process({
        data: { runId: id },
      } as Job<RunJob>);

      expect(await prisma.run.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: "STOPPED",
        stopReason: "Add a resume URL in settings before starting a run",
      });
      expect(await effect.runPromise(Effect.succeed("ran"))).toBe("ran");
    } finally {
      await effect.onApplicationShutdown();
      await prisma.run.deleteMany({ where: { userId: noResume } });
    }
  });

  describe("on a schedule tick", () => {
    // Each tick starts from a schedule that is on and no runs.
    beforeEach(async () => {
      await prisma.run.deleteMany({ where: { userId } });
      await prisma.settings.update({ where: { userId }, data: { scheduleMinutes: 60 } });
    });

    it("queues a scheduled run on a tick", async () => {
      const { queue, calls } = recordingQueue();

      await new RunsProcessor(prisma, noEffects, queue).process(scheduledJobFor(userId));

      const run = await prisma.run.findFirstOrThrow({ where: { userId } });
      expect(run).toMatchObject({ trigger: "SCHEDULED", status: "QUEUED" });
      expect(calls).toEqual([["add", "run", { runId: run.id }, { jobId: run.id, attempts: 1 }]]);
    });

    it("skips a tick while a run is active", async () => {
      await prisma.run.create({
        data: { userId, trigger: "MANUAL", contextKey: "test", sourceIds: [] },
      });
      const { queue, calls } = recordingQueue();

      await new RunsProcessor(prisma, noEffects, queue).process(scheduledJobFor(userId));

      expect(calls).toEqual([]);
      expect(await prisma.run.count({ where: { userId } })).toBe(1);
    });

    it("removes the scheduler on a tick once the schedule is turned off", async () => {
      await prisma.settings.update({ where: { userId }, data: { scheduleMinutes: null } });
      const { queue, calls } = recordingQueue();

      await new RunsProcessor(prisma, noEffects, queue).process(scheduledJobFor(userId));

      expect(calls).toEqual([["remove", `user:${userId}`]]);
    });
  });
});
