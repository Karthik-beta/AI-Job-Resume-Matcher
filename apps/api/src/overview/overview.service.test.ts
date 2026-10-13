import { describe, expect, test } from "bun:test";
import { defaultSettings } from "@job-matcher/shared";
import type { Queue } from "bullmq";
import type { Settings } from "../generated/prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import { estimateNextRun, OverviewService } from "./overview.service";

const userId = "user-1";
const now = new Date("2026-10-13T12:00:00.000Z");
const minute = 60_000;

// A saved settings row: the defaults, with the given changes.
const settingsRow = (changes: Partial<Settings>): Settings => ({
  userId,
  ...defaultSettings,
  locations: [],
  titleInclude: [],
  titleExclude: [],
  onboardingCompletedAt: null,
  onboardingDismissedAt: null,
  ...changes,
});

interface Rows {
  readonly settings?: Settings | null;
  readonly sourceCount?: number;
  readonly latestRun?: object | null;
  readonly activeRun?: { id: string; status: string } | null;
  readonly pendingMatches?: number;
  readonly lastScheduledRun?: { createdAt: Date } | null;
}

type Where = {
  where: { userId: string; status?: unknown; trigger?: string };
  orderBy?: unknown;
};

// Answers each query the service makes, and records the filters so tests can check the scoping.
const fakePrisma = (rows: Rows) => {
  const wheres: Where["where"][] = [];
  const runQueries: Where[] = [];
  const seen = <A>({ where }: Where, value: A) => {
    wheres.push(where);
    return Promise.resolve(value);
  };
  const prisma = {
    settings: { findUnique: (args: Where) => seen(args, rows.settings ?? null) },
    jobSource: { count: (args: Where) => seen(args, rows.sourceCount ?? 0) },
    run: {
      findFirst: (args: Where) => {
        runQueries.push(args);
        return seen(
          args,
          args.where.status
            ? (rows.activeRun ?? null)
            : args.where.trigger === "SCHEDULED"
              ? (rows.lastScheduledRun ?? null)
              : (rows.latestRun ?? null),
        );
      },
    },
    match: { count: (args: Where) => seen(args, rows.pendingMatches ?? 0) },
  } as unknown as PrismaService;
  return { prisma, wheres, runQueries };
};

const fakeQueue = (getJobScheduler: (id: string) => Promise<{ next?: number } | undefined>) =>
  ({ getJobScheduler }) as unknown as Queue;

const noScheduler = fakeQueue(() => Promise.reject(new Error("No scheduler expected")));

describe("OverviewService", () => {
  test("a brand-new user has nothing set up", async () => {
    const { prisma, wheres } = fakePrisma({});
    const overview = await new OverviewService(prisma, noScheduler).get(userId, now);

    expect(overview).toEqual({
      setup: { hasResume: false, sourceCount: 0, hasPreferences: false, hasRun: false },
      latestRun: null,
      activeRun: null,
      pendingMatches: 0,
      nextScheduledRunAt: null,
      onboarding: {
        steps: { resume: false, preferences: false, source: false, firstRun: false },
        nextStep: "resume",
        completedAt: null,
        dismissedAt: null,
      },
    });
    expect(wheres.length).toBe(5);
    expect(wheres.every((where) => where.userId === userId)).toBe(true);
  });

  test("reports the active run and the latest run's matches", async () => {
    const { prisma, runQueries } = fakePrisma({
      settings: settingsRow({
        resumeUrl: "https://example.com/cv.pdf",
        onboardingCompletedAt: new Date("2026-10-13T11:59:00.000Z"),
      }),
      sourceCount: 3,
      latestRun: {
        id: "run-2",
        status: "RUNNING",
        createdAt: new Date("2026-10-13T11:59:00.000Z"),
        finishedAt: null,
        _count: { results: 2 },
      },
      activeRun: { id: "run-2", status: "RUNNING" },
      pendingMatches: 4,
    });
    const overview = await new OverviewService(prisma, noScheduler).get(userId, now);

    expect(overview).toEqual({
      setup: { hasResume: true, sourceCount: 3, hasPreferences: true, hasRun: true },
      latestRun: {
        id: "run-2",
        status: "RUNNING",
        createdAt: "2026-10-13T11:59:00.000Z",
        finishedAt: null,
        matchCount: 2,
      },
      activeRun: { id: "run-2", status: "RUNNING" },
      pendingMatches: 4,
      nextScheduledRunAt: null,
      onboarding: {
        steps: { resume: true, preferences: false, source: true, firstRun: true },
        nextStep: null,
        completedAt: "2026-10-13T11:59:00.000Z",
        dismissedAt: null,
      },
    });
    const activeQuery = runQueries.find(({ where }) => where.status);
    expect(activeQuery?.orderBy).toEqual({ createdAt: "desc" });
  });

  test("reports a queued run with its finished latest run", async () => {
    const { prisma } = fakePrisma({
      settings: settingsRow({ onboardingDismissedAt: new Date("2026-10-12T09:00:00.000Z") }),
      latestRun: {
        id: "run-1",
        status: "COMPLETED",
        createdAt: new Date("2026-10-12T10:00:00.000Z"),
        finishedAt: new Date("2026-10-12T10:03:00.000Z"),
        _count: { results: 0 },
      },
      activeRun: { id: "run-3", status: "QUEUED" },
    });
    const overview = await new OverviewService(prisma, noScheduler).get(userId, now);

    expect(overview.setup).toMatchObject({ hasResume: false, hasPreferences: true });
    expect(overview.latestRun).toMatchObject({ finishedAt: "2026-10-12T10:03:00.000Z" });
    expect(overview.activeRun).toEqual({ id: "run-3", status: "QUEUED" });
    expect(overview.onboarding).toMatchObject({
      steps: { resume: false, preferences: false, source: false, firstRun: true },
      nextStep: "resume",
      dismissedAt: "2026-10-12T09:00:00.000Z",
    });
  });

  describe("with scheduling enabled", () => {
    const settings = settingsRow({ resumeUrl: "https://example.com/cv.pdf", scheduleMinutes: 60 });
    const sourceCount = 2;
    const lastScheduledRun = { createdAt: new Date("2026-10-13T09:30:00.000Z") };

    test("reads the next tick from the user's job scheduler", async () => {
      const { prisma } = fakePrisma({ settings, sourceCount, lastScheduledRun });
      const ids: string[] = [];
      const queue = fakeQueue((id) => {
        ids.push(id);
        return Promise.resolve({ next: Date.parse("2026-10-13T12:20:00.000Z") });
      });
      const overview = await new OverviewService(prisma, queue).get(userId, now);

      expect(ids).toEqual([`user:${userId}`]);
      expect(overview.nextScheduledRunAt).toBe("2026-10-13T12:20:00.000Z");
    });

    test("estimates from the last scheduled run when Redis fails", async () => {
      const { prisma, wheres } = fakePrisma({ settings, sourceCount, lastScheduledRun });
      const queue = fakeQueue(() => Promise.reject(new Error("Redis is down")));
      const overview = await new OverviewService(prisma, queue).get(userId, now);

      expect(overview.nextScheduledRunAt).toBe("2026-10-13T12:30:00.000Z");
      expect(wheres.at(-1)).toEqual({ userId, trigger: "SCHEDULED" });
    });

    test("estimates when the scheduler is missing", async () => {
      const { prisma } = fakePrisma({ settings, sourceCount, lastScheduledRun });
      const queue = fakeQueue(() => Promise.resolve(undefined));
      const overview = await new OverviewService(prisma, queue).get(userId, now);

      expect(overview.nextScheduledRunAt).toBe("2026-10-13T12:30:00.000Z");
    });

    test("stops waiting for a Redis that does not answer", async () => {
      const { prisma } = fakePrisma({ settings, sourceCount });
      const queue = fakeQueue(() => new Promise(() => {}));
      const overview = await new OverviewService(prisma, queue).get(userId, now);

      expect(overview.nextScheduledRunAt).toBeNull();
    });

    // Ticks start no run until setup is complete, so no next check is promised.
    for (const [name, rows] of [
      ["without a resume", { settings: { ...settings, resumeUrl: null }, sourceCount }],
      ["without sources", { settings, sourceCount: 0 }],
    ] as const) {
      test(`is null ${name}`, async () => {
        const { prisma } = fakePrisma({ ...rows, lastScheduledRun });
        const overview = await new OverviewService(prisma, noScheduler).get(userId, now);

        expect(overview.nextScheduledRunAt).toBeNull();
      });
    }
  });
});

describe("estimateNextRun", () => {
  const last = new Date("2026-10-13T11:30:00.000Z");

  test("is null before the first scheduled run", () => {
    expect(estimateNextRun(null, 60 * minute, now)).toBeNull();
  });

  test("is one interval after the last scheduled run", () => {
    expect(estimateNextRun(last, 60 * minute, now)).toEqual(new Date("2026-10-13T12:30:00.000Z"));
  });

  test("steps over ticks that started no run", () => {
    expect(estimateNextRun(last, 15 * minute, now)).toEqual(new Date("2026-10-13T12:15:00.000Z"));
    // Exactly on a tick: the next one is a whole interval away.
    expect(estimateNextRun(last, 30 * minute, now)).toEqual(new Date("2026-10-13T12:30:00.000Z"));
  });

  test("is one interval after a run dated in the future", () => {
    const future = new Date("2026-10-13T12:10:00.000Z");
    expect(estimateNextRun(future, 15 * minute, now)).toEqual(new Date("2026-10-13T12:25:00.000Z"));
  });
});
