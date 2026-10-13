import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { defaultSettings } from "@job-matcher/shared";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { PrismaService } from "../src/prisma/prisma.service";
import { createRun, createScheduledRun } from "../src/runs/create-run";
import { signUp, startApp } from "./helpers";

type Agent = Awaited<ReturnType<typeof signUp>>;

const resumeUrl = "https://example.com/cv.pdf";

const newUser = {
  steps: { resume: false, preferences: false, source: false, firstRun: false },
  nextStep: "resume",
  completedAt: null,
  dismissedAt: null,
};

describe("onboarding", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const userIds: string[] = [];

  const user = async () => {
    const agent = await signUp(app.getHttpServer());
    const session = await agent.get("/api/auth/get-session").expect(200);
    const id = session.body.user.id as string;
    userIds.push(id);
    return { agent, id };
  };

  const onboardingOf = async (agent: Agent) =>
    (await agent.get("/api/overview").expect(200)).body.onboarding;

  const setUp = async (agent: Agent) => {
    await agent
      .put("/api/settings")
      .send({ ...defaultSettings, resumeUrl })
      .expect(200);
    const source = await agent.post("/api/sources").send({ url: "https://example.com/jobs" });
    expect(source.status).toBe(201);
    return source.body.id as string;
  };

  beforeAll(async () => {
    app = await startApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.run.deleteMany({ where: { userId: { in: userIds } } });
    await app.close();
  });

  it("rejects requests without a session", async () => {
    for (const action of ["complete", "dismiss", "restore"]) {
      await request(app.getHttpServer()).post(`/api/onboarding/${action}`).expect(401);
    }
  });

  it("starts at the resume for a new user", async () => {
    const { agent } = await user();
    expect(await onboardingOf(agent)).toEqual(newUser);
  });

  it("follows partial progress", async () => {
    const { agent } = await user();
    await agent
      .put("/api/settings")
      .send({ ...defaultSettings, resumeUrl })
      .expect(200);
    expect(await onboardingOf(agent)).toMatchObject({
      steps: { resume: true, preferences: false, source: false, firstRun: false },
      nextStep: "preferences",
    });

    await agent
      .put("/api/settings")
      .send({ ...defaultSettings, resumeUrl, locations: ["Remote"] })
      .expect(200);
    expect(await onboardingOf(agent)).toMatchObject({
      steps: { resume: true, preferences: true, source: false },
      nextStep: "source",
    });

    await agent.post("/api/sources").send({ url: "https://example.com/jobs" }).expect(201);
    expect(await onboardingOf(agent)).toEqual({
      steps: { resume: true, preferences: true, source: true, firstRun: false },
      nextStep: "firstRun",
      completedAt: null,
      dismissedAt: null,
    });
  });

  it("completes when the first run starts", async () => {
    const { agent, id } = await user();
    const sourceId = await setUp(agent);
    const created = await createRun(prisma, {
      userId: id,
      sourceIds: [sourceId],
      trigger: "MANUAL",
      model: "m",
    });
    if (created._tag !== "Created") throw new Error(`Run not created: ${created._tag}`);

    expect(await onboardingOf(agent)).toEqual({
      steps: { resume: true, preferences: false, source: true, firstRun: true },
      nextStep: null,
      completedAt: created.run.createdAt.toISOString(),
      dismissedAt: null,
    });
  });

  it("completes when the first scheduled run starts, and keeps that time", async () => {
    const { agent, id } = await user();
    await setUp(agent);
    const run = await createScheduledRun(prisma, id, "m");
    expect(run).not.toBeNull();
    const { completedAt } = await onboardingOf(agent);
    expect(completedAt).toBe(run?.createdAt.toISOString());

    // A later completion keeps the first time.
    const response = await agent.post("/api/onboarding/complete").expect(200);
    expect(response.body.completedAt).toBe(completedAt);
  });

  it("does not complete when a run cannot start", async () => {
    const { agent, id } = await user();
    await agent
      .put("/api/settings")
      .send({ ...defaultSettings, resumeUrl })
      .expect(200);
    expect((await createScheduledRun(prisma, id, "m")) ?? null).toBeNull();
    expect((await onboardingOf(agent)).completedAt).toBeNull();
  });

  it("completes on request, once, for a user with no settings", async () => {
    const { agent, id } = await user();
    const first = await agent.post("/api/onboarding/complete").expect(200);
    expect(first.body.completedAt).toBeString();
    const again = await agent.post("/api/onboarding/complete").expect(200);
    expect(again.body).toEqual(first.body);

    // The row holds the defaults, so the settings and the steps read as before.
    expect((await agent.get("/api/settings").expect(200)).body).toEqual(defaultSettings);
    expect(first.body).toEqual({ ...newUser, completedAt: first.body.completedAt });
    expect(await prisma.settings.findUnique({ where: { userId: id } })).toMatchObject({
      locations: [],
      onboardingDismissedAt: null,
    });
  });

  it("dismisses once and restores", async () => {
    const { agent } = await user();
    const dismissed = await agent.post("/api/onboarding/dismiss").expect(200);
    expect(dismissed.body).toEqual({ ...newUser, dismissedAt: expect.any(String) });
    const again = await agent.post("/api/onboarding/dismiss").expect(200);
    expect(again.body.dismissedAt).toBe(dismissed.body.dismissedAt);
    expect((await onboardingOf(agent)).dismissedAt).toBe(dismissed.body.dismissedAt);

    const restored = await agent.post("/api/onboarding/restore").expect(200);
    expect(restored.body).toEqual(newUser);
    await agent.post("/api/onboarding/restore").expect(200);
    expect(await onboardingOf(agent)).toEqual(newUser);

    // Dismissing again after a restore records the new time.
    const later = await agent.post("/api/onboarding/dismiss").expect(200);
    expect(later.body.dismissedAt).toBeString();
  });

  it("restores for a user who never dismissed", async () => {
    const { agent, id } = await user();
    expect((await agent.post("/api/onboarding/restore").expect(200)).body).toEqual(newUser);
    expect(await prisma.settings.findUnique({ where: { userId: id } })).toBeNull();
  });

  it("changes only the session user's flags", async () => {
    const alice = await user();
    const bob = await user();
    await alice.agent.post("/api/onboarding/dismiss").expect(200);
    await alice.agent.post("/api/onboarding/complete").expect(200);
    expect(await onboardingOf(bob.agent)).toEqual(newUser);
  });
});
