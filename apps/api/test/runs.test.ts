import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { defaultSettings } from "@job-matcher/shared";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import type { Queue } from "bullmq";
import request from "supertest";
import { PrismaService } from "../src/prisma/prisma.service";
import { MatchAlerts } from "../src/runs/match-alerts";
import type { RunJob } from "../src/runs/runs.queue";
import { signUp, startApp } from "./helpers";

type Agent = Awaited<ReturnType<typeof signUp>>;

const addSource = async (agent: Agent): Promise<string> => {
  const response = await agent.post("/api/sources").send({ url: "https://example.com/jobs" });
  return response.body.id;
};

describe("runs", () => {
  let app: INestApplication;
  let queue: Queue<RunJob>;
  let alice: Agent;
  let bob: Agent;
  let aliceSource: string;
  let bobSource: string;
  const runIds: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    queue = app.get(getQueueToken("runs"));
    alice = await signUp(app.getHttpServer());
    bob = await signUp(app.getHttpServer());
    aliceSource = await addSource(alice);
    bobSource = await addSource(bob);
  });

  afterAll(async () => {
    await Promise.all(runIds.map((id) => queue.remove(id)));
    await app.close();
  });

  it("rejects requests without a session", async () => {
    await request(app.getHttpServer())
      .post("/api/runs")
      .send({ sourceIds: [aliceSource] })
      .expect(401);
  });

  it("requires a resume URL", async () => {
    const response = await alice
      .post("/api/runs")
      .send({ sourceIds: [aliceSource] })
      .expect(400);
    expect(response.body.message).toContain("resume URL");
  });

  it("requires at least one source", async () => {
    await alice
      .put("/api/settings")
      .send({ ...defaultSettings, resumeUrl: "https://example.com/cv.pdf" })
      .expect(200);
    await alice.post("/api/runs").send({ sourceIds: [] }).expect(400);
    await alice.post("/api/runs").send({}).expect(400);
  });

  it("rejects another user's source", async () => {
    await alice
      .post("/api/runs")
      .send({ sourceIds: [bobSource] })
      .expect(400);
  });

  it("creates a queued run and enqueues it under the run id", async () => {
    const response = await alice
      .post("/api/runs")
      .send({ sourceIds: [aliceSource, aliceSource] })
      .expect(201);
    const run = response.body;
    runIds.push(run.id);
    expect(run).toMatchObject({ status: "QUEUED", trigger: "MANUAL", sourceIds: [aliceSource] });
    expect(run.contextKey).toMatch(/^[0-9a-f]{64}$/);

    const job = await queue.getJob(run.id);
    expect(job?.data).toEqual({ runId: run.id });
  });

  it("rejects a second run while one is active", async () => {
    const response = await alice
      .post("/api/runs")
      .send({ sourceIds: [aliceSource] })
      .expect(409);
    expect(response.body.message).toBe("A run is already in progress");
  });

  it("lets only one of two simultaneous starts through", async () => {
    await bob
      .put("/api/settings")
      .send({ ...defaultSettings, resumeUrl: "https://example.com/cv.pdf" })
      .expect(200);
    const responses = await Promise.all([
      bob.post("/api/runs").send({ sourceIds: [bobSource] }),
      bob.post("/api/runs").send({ sourceIds: [bobSource] }),
    ]);
    const statuses = responses.map(({ status }) => status).sort();
    expect(statuses).toEqual([201, 409]);
    for (const { status, body } of responses) if (status === 201) runIds.push(body.id);
  });
});

describe("run status", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let carol: Agent;
  let dave: Agent;
  let carolId: string;

  const createRun = (createdAt: Date) =>
    prisma.run.create({
      data: { userId: carolId, trigger: "MANUAL", contextKey: "test", sourceIds: [], createdAt },
    });

  beforeAll(async () => {
    app = await startApp();
    prisma = app.get(PrismaService);
    carol = await signUp(app.getHttpServer());
    dave = await signUp(app.getHttpServer());
    const session = await carol.get("/api/auth/get-session").expect(200);
    carolId = session.body.user.id;
  });

  afterAll(async () => {
    await prisma.run.deleteMany({ where: { userId: carolId } });
    await prisma.match.deleteMany({ where: { userId: carolId } });
    await prisma.settings.deleteMany({ where: { userId: carolId } });
    await app.close();
  });

  it("rejects requests without a session", async () => {
    await request(app.getHttpServer()).get("/api/runs").expect(401);
  });

  it("lists the 20 most recent runs, newest first", async () => {
    const runs = [];
    for (let minute = 0; minute < 21; minute++) {
      runs.push(await createRun(new Date(Date.UTC(2026, 0, 1, 0, minute))));
    }

    const response = await carol.get("/api/runs").expect(200);
    const ids = response.body.map(({ id }: { id: string }) => id);
    expect(ids).toEqual(
      runs
        .slice(1)
        .reverse()
        .map(({ id }) => id),
    );
  });

  it("returns a run with its counts, stop reason and job results", async () => {
    const run = await createRun(new Date());
    await prisma.run.update({
      where: { id: run.id },
      data: { status: "STOPPED", stopReason: "User not found.", found: 3, eligible: 2, checked: 1 },
    });
    await prisma.jobResult.create({
      data: {
        runId: run.id,
        userId: carolId,
        contextKey: "test",
        jobUrl: "https://jobs.example.com/1",
        title: "Engineer",
        company: "Example",
        isMatch: true,
        reason: "Strong fit",
        matchSaved: true,
      },
    });

    const response = await carol.get(`/api/runs/${run.id}`).expect(200);
    expect(response.body).toMatchObject({
      id: run.id,
      status: "STOPPED",
      stopReason: "User not found.",
      found: 3,
      eligible: 2,
      checked: 1,
      failed: 0,
      results: [
        { jobUrl: "https://jobs.example.com/1", isMatch: true, reason: "Strong fit", error: null },
      ],
    });
  });

  it("saves a match whose first save failed", async () => {
    const run = await createRun(new Date());
    await prisma.run.update({ where: { id: run.id }, data: { checked: 1, failed: 1 } });
    const result = await prisma.jobResult.create({
      data: {
        runId: run.id,
        userId: carolId,
        contextKey: "retry",
        jobUrl: "https://jobs.example.com/retry",
        title: "Engineer",
        company: "Example",
        locations: ["Pune"],
        expMinYears: 2,
        isMatch: true,
        reason: "Strong fit",
      },
    });
    const path = `/api/runs/${run.id}/results/${result.id}/save`;

    const responses = await Promise.all([carol.post(path), carol.post(path)]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ id: result.id, matchSaved: true });
    }

    const match = await prisma.match.findUniqueOrThrow({
      where: { userId_jobUrl: { userId: carolId, jobUrl: "https://jobs.example.com/retry" } },
    });
    expect(match).toMatchObject({ locations: ["Pune"], expMinYears: 2, status: "PENDING" });
    const updated = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(updated.failed).toBe(0);
    await dave.post(path).expect(404);
  });

  it("sends the Discord alert once after a retried save", async () => {
    const webhook = "https://discord.com/api/webhooks/1/token";
    await prisma.settings.upsert({
      where: { userId: carolId },
      create: { userId: carolId, discordWebhookUrl: webhook },
      update: { discordWebhookUrl: webhook },
    });
    const send = spyOn(app.get(MatchAlerts), "send");
    try {
      const run = await createRun(new Date());
      await prisma.run.update({ where: { id: run.id }, data: { checked: 1, failed: 1 } });
      const result = await prisma.jobResult.create({
        data: {
          runId: run.id,
          userId: carolId,
          contextKey: "retry",
          jobUrl: "https://jobs.example.com/retry-alert",
          title: "Engineer",
          company: "Example",
          isMatch: true,
          reason: "Strong fit",
        },
      });
      const path = `/api/runs/${run.id}/results/${result.id}/save`;

      await Promise.all([carol.post(path).expect(200), carol.post(path).expect(200)]);
      await carol.post(path).expect(200);

      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(webhook, {
        title: "Engineer",
        company: "Example",
        jobUrl: "https://jobs.example.com/retry-alert",
        reason: "Strong fit",
      });
    } finally {
      send.mockRestore();
      await prisma.settings.update({
        where: { userId: carolId },
        data: { discordWebhookUrl: null },
      });
    }
  });

  it("only logs an alert that fails", async () => {
    const alert = { title: "Engineer", company: "Example", jobUrl: "https://x.test", reason: "" };
    await expect(
      app.get(MatchAlerts).send("https://example.com/not-discord", alert),
    ).resolves.toBeUndefined();
  });

  it("only saves results that are matches", async () => {
    const run = await createRun(new Date());
    const result = await prisma.jobResult.create({
      data: {
        runId: run.id,
        userId: carolId,
        contextKey: "retry",
        jobUrl: "https://jobs.example.com/no-match",
        title: "Engineer",
        company: "Example",
        isMatch: false,
        reason: "Missing skills",
      },
    });
    await carol.post(`/api/runs/${run.id}/results/${result.id}/save`).expect(409);
  });

  it("hides another user's run", async () => {
    const run = await createRun(new Date());
    await dave.get(`/api/runs/${run.id}`).expect(404);
    await carol.get("/api/runs/missing").expect(404);
    const list = await dave.get("/api/runs").expect(200);
    expect(list.body).toEqual([]);
  });
});

describe("health", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await startApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("reports the database and Redis", async () => {
    const response = await request(app.getHttpServer()).get("/api/health").expect(200);
    expect(response.body).toEqual({ database: "up", redis: "up" });
  });
});
