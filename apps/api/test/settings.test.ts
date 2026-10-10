import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { defaultSettings } from "@job-matcher/shared";
import type { INestApplication } from "@nestjs/common";
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
});
