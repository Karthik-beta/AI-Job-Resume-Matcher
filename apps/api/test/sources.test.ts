import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { PrismaService } from "../src/prisma/prisma.service";
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

  it("detects the source kind from the URL", async () => {
    const ats = await alice
      .post("/api/sources")
      .send({ url: "https://job-boards.greenhouse.io/stripe" })
      .expect(201);
    expect(ats.body).toMatchObject({ kind: "GREENHOUSE", adapterKey: "stripe", maxPages: 3 });

    const page = await alice
      .post("/api/sources")
      .send({ url: "https://example.com/open-roles" })
      .expect(201);
    expect(page.body).toMatchObject({ kind: "PAGE", adapterKey: null });
  });

  it("overrides the kind and clears the cached listings", async () => {
    const url = "https://careers.example.com/jobs";
    const { body: source } = await alice.post("/api/sources").send({ url }).expect(201);
    const prisma = new PrismaService();
    try {
      await prisma.pageCache.create({
        data: { userId: source.userId, url, kind: "SOURCE_LISTING", content: [] },
      });
      const updated = await alice
        .patch(`/api/sources/${source.id}`)
        .send({ kind: "LEVER", adapterKey: " acme " })
        .expect(200);
      expect(updated.body).toMatchObject({ kind: "LEVER", adapterKey: "acme" });
      expect(await prisma.pageCache.count({ where: { userId: source.userId, url } })).toBe(0);

      const reverted = await alice
        .patch(`/api/sources/${source.id}`)
        .send({ kind: "PAGE", adapterKey: "acme" })
        .expect(200);
      expect(reverted.body).toMatchObject({ kind: "PAGE", adapterKey: null });
    } finally {
      await prisma.$disconnect();
    }
  });

  it.each([
    [{ kind: "GREENHOUSE", adapterKey: null }],
    [{ kind: "ASHBY", adapterKey: "  " }],
    [{ kind: "SEARCH", adapterKey: null }],
    [{ kind: "OTHER", adapterKey: null }],
  ])("rejects an invalid override: %p", async (body) => {
    const { body: source } = await alice
      .post("/api/sources")
      .send({ url: `https://example.com/${crypto.randomUUID()}` })
      .expect(201);
    await alice.patch(`/api/sources/${source.id}`).send(body).expect(400);
  });

  it("hides sources from other users", async () => {
    const created = await alice
      .post("/api/sources")
      .send({ url: "https://example.com/private" })
      .expect(201);

    const list = await bob.get("/api/sources").expect(200);
    expect(list.body).toHaveLength(0);
    await bob.delete(`/api/sources/${created.body.id}`).expect(404);
    await bob
      .patch(`/api/sources/${created.body.id}`)
      .send({ kind: "PAGE", adapterKey: null })
      .expect(404);
  });
});
