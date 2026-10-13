import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { defaultSettings } from "@job-matcher/shared";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import type { Queue } from "bullmq";
import request from "supertest";
import type { RunStatus } from "../src/generated/prisma/client";
import { PrismaService } from "../src/prisma/prisma.service";
import { signUp, startApp } from "./helpers";

type Agent = Awaited<ReturnType<typeof signUp>>;

const empty = {
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
};

describe("overview", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let alice: Agent;
  let bob: Agent;
  let aliceId: string;
  let bobId: string;

  const userIdOf = async (agent: Agent) => {
    const session = await agent.get("/api/auth/get-session").expect(200);
    return session.body.user.id as string;
  };

  const addRun = (userId: string, status: RunStatus, createdAt: Date) =>
    prisma.run.create({
      data: { userId, trigger: "MANUAL", status, contextKey: "test", sourceIds: [], createdAt },
    });

  const addMatch = (userId: string, jobUrl: string, status: "PENDING" | "APPLIED") =>
    prisma.match.create({
      data: { userId, jobUrl, title: "Engineer", company: "Example", reason: "Fit", status },
    });

  beforeAll(async () => {
    app = await startApp();
    prisma = app.get(PrismaService);
    alice = await signUp(app.getHttpServer());
    bob = await signUp(app.getHttpServer());
    aliceId = await userIdOf(alice);
    bobId = await userIdOf(bob);
  });

  afterAll(async () => {
    const userId = { in: [aliceId, bobId] };
    await prisma.run.deleteMany({ where: { userId } });
    await prisma.match.deleteMany({ where: { userId } });
    await app.close();
  });

  it("rejects requests without a session", async () => {
    await request(app.getHttpServer()).get("/api/overview").expect(401);
  });

  it("starts empty for a new user", async () => {
    expect((await alice.get("/api/overview").expect(200)).body).toEqual(empty);
  });

  it("counts only the session user's data", async () => {
    await alice
      .put("/api/settings")
      .send({ ...defaultSettings, resumeUrl: "https://example.com/cv.pdf" })
      .expect(200);
    await alice.post("/api/sources").send({ url: "https://example.com/jobs" }).expect(201);
    const finished = await addRun(aliceId, "COMPLETED", new Date("2026-01-01"));
    await prisma.run.update({
      where: { id: finished.id },
      data: { finishedAt: new Date("2026-01-01T00:05:00Z") },
    });
    await prisma.jobResult.createMany({
      data: [true, true, false, null].map((isMatch, index) => ({
        runId: finished.id,
        userId: aliceId,
        contextKey: "test",
        jobUrl: `https://jobs.example.com/${index}`,
        title: "Engineer",
        company: "Example",
        isMatch,
      })),
    });
    await addMatch(aliceId, "https://jobs.example.com/a", "PENDING");
    await addMatch(aliceId, "https://jobs.example.com/b", "APPLIED");

    // Bob's data, newer than Alice's, must not show up in her overview.
    await bob.post("/api/sources").send({ url: "https://example.com/bob" }).expect(201);
    await bob.post("/api/sources").send({ url: "https://example.com/bob/2" }).expect(201);
    const bobRun = await addRun(bobId, "RUNNING", new Date("2026-02-01"));
    await addMatch(bobId, "https://jobs.example.com/a", "PENDING");
    await addMatch(bobId, "https://jobs.example.com/c", "PENDING");

    expect((await alice.get("/api/overview").expect(200)).body).toEqual({
      setup: { hasResume: true, sourceCount: 1, hasPreferences: false, hasRun: true },
      latestRun: {
        id: finished.id,
        status: "COMPLETED",
        createdAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:05:00.000Z",
        matchCount: 2,
      },
      activeRun: null,
      pendingMatches: 1,
      nextScheduledRunAt: null,
      // The run was added directly, not started through createRun, so nothing completed setup.
      onboarding: {
        steps: { resume: true, preferences: false, source: true, firstRun: true },
        nextStep: null,
        completedAt: null,
        dismissedAt: null,
      },
    });

    expect((await bob.get("/api/overview").expect(200)).body).toEqual({
      setup: { hasResume: false, sourceCount: 2, hasPreferences: false, hasRun: true },
      latestRun: {
        id: bobRun.id,
        status: "RUNNING",
        createdAt: "2026-02-01T00:00:00.000Z",
        finishedAt: null,
        matchCount: 0,
      },
      activeRun: { id: bobRun.id, status: "RUNNING" },
      pendingMatches: 2,
      nextScheduledRunAt: null,
      onboarding: {
        steps: { resume: false, preferences: false, source: true, firstRun: true },
        nextStep: "resume",
        completedAt: null,
        dismissedAt: null,
      },
    });
  });

  it("reports the next tick of the user's schedule", async () => {
    const queue = app.get<Queue>(getQueueToken("runs"));
    // Alice has a source; with a resume too, ticks would start runs. An active run makes a tick
    // a running dev worker picks up start nothing.
    const active = await addRun(aliceId, "RUNNING", new Date());
    const scheduled = {
      ...defaultSettings,
      resumeUrl: "https://example.com/cv.pdf",
      scheduleMinutes: 15,
    };
    await alice.put("/api/settings").send(scheduled).expect(200);
    const nextTick = async () => {
      const scheduler = await queue.getJobScheduler(`user:${aliceId}`);
      expect(scheduler?.next).toBeNumber();
      return new Date(scheduler?.next ?? 0).toISOString();
    };

    // A running dev worker may take the first tick, which moves the scheduler on by an interval.
    const before = await nextTick();
    const overview = await alice.get("/api/overview").expect(200);
    expect([before, await nextTick()]).toContain(overview.body.nextScheduledRunAt);
    expect((await bob.get("/api/overview").expect(200)).body.nextScheduledRunAt).toBeNull();

    // Without a resume a tick starts no run, so no next check is promised.
    await alice
      .put("/api/settings")
      .send({ ...scheduled, resumeUrl: null })
      .expect(200);
    expect((await alice.get("/api/overview").expect(200)).body.nextScheduledRunAt).toBeNull();

    await alice.put("/api/settings").send(defaultSettings).expect(200);
    expect((await alice.get("/api/overview").expect(200)).body.nextScheduledRunAt).toBeNull();
    await prisma.run.delete({ where: { id: active.id } });
  });
});
