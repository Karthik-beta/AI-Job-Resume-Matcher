import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { signUp, startApp } from "./helpers";

describe("job sources", () => {
  let app: INestApplication;
  let alice: Awaited<ReturnType<typeof signUp>>;
  let bob: Awaited<ReturnType<typeof signUp>>;

  beforeAll(async () => {
    app = await startApp();
    alice = await signUp(app.getHttpServer());
    bob = await signUp(app.getHttpServer());
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects requests without a session", async () => {
    await request(app.getHttpServer()).get("/api/sources").expect(401);
  });

  it("adds, lists and deletes a source", async () => {
    const url = "https://example.com/careers";
    const created = await alice.post("/api/sources").send({ url }).expect(201);
    expect(created.body.url).toBe(url);

    const list = await alice.get("/api/sources").expect(200);
    expect(list.body).toHaveLength(1);

    await alice.delete(`/api/sources/${created.body.id}`).expect(204);
    const after = await alice.get("/api/sources").expect(200);
    expect(after.body).toHaveLength(0);
  });

  it("rejects an invalid URL", async () => {
    await alice.post("/api/sources").send({ url: "not a url" }).expect(400);
  });

  it("rejects a duplicate URL", async () => {
    const url = "https://example.com/jobs";
    await alice.post("/api/sources").send({ url }).expect(201);
    await alice.post("/api/sources").send({ url }).expect(409);
  });

  it("hides sources from other users", async () => {
    const created = await alice
      .post("/api/sources")
      .send({ url: "https://example.com/private" })
      .expect(201);

    const list = await bob.get("/api/sources").expect(200);
    expect(list.body).toHaveLength(0);
    await bob.delete(`/api/sources/${created.body.id}`).expect(404);
  });
});
