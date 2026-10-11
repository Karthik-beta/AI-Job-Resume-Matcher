import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { defaultSettings } from "@job-matcher/shared";
import { getQueueToken } from "@nestjs/bullmq";
import type { INestApplication } from "@nestjs/common";
import type { Queue } from "bullmq";
import request from "supertest";
import { signUp, startApp } from "./helpers";

describe("settings", () => {
  let app: INestApplication;
  let user: Awaited<ReturnType<typeof signUp>>;

  beforeAll(async () => {
    app = await startApp();
    user = await signUp(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects requests without a session", async () => {
    await request(app.getHttpServer()).get("/api/settings").expect(401);
  });

  it("returns defaults before anything is saved", async () => {
    const response = await user.get("/api/settings").expect(200);
    expect(response.body).toEqual(defaultSettings);
  });

  it("saves settings", async () => {
    const settings = {
      ...defaultSettings,
      resumeUrl: "https://example.com/resume.pdf",
      experienceYears: 3,
      experienceMonths: 6,
      targetMinYears: 2,
      targetMaxYears: 5,
      locations: ["Bengaluru", "Remote"],
      scheduleMinutes: 60,
    };
    await user.put("/api/settings").send(settings).expect(200);
    const response = await user.get("/api/settings").expect(200);
    expect(response.body).toEqual(settings);
  });

  it("rejects 12 months of experience", async () => {
    await user
      .put("/api/settings")
      .send({ ...defaultSettings, experienceMonths: 12 })
      .expect(400);
  });

  it("rejects a minimum above the maximum", async () => {
    await user
      .put("/api/settings")
      .send({ ...defaultSettings, targetMinYears: 5, targetMaxYears: 2 })
      .expect(400);
  });

  it("keeps the user's job scheduler in step with the schedule", async () => {
    const queue = app.get<Queue>(getQueueToken("runs"));
    const session = await user.get("/api/auth/get-session").expect(200);
    const schedulerId = `user:${session.body.user.id}`;

    await user
      .put("/api/settings")
      .send({ ...defaultSettings, scheduleMinutes: 30 })
      .expect(200);
    const scheduler = await queue.getJobScheduler(schedulerId);
    expect(scheduler).toMatchObject({ every: 1_800_000, name: "scheduled" });

    await user.put("/api/settings").send(defaultSettings).expect(200);
    expect(await queue.getJobScheduler(schedulerId)).toBeUndefined();
  });
});
