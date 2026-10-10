import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { defaultSettings } from "@job-matcher/shared";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import type { Queue } from "bullmq";
import request from "supertest";
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
