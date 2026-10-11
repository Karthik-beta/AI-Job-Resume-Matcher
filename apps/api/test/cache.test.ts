import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { PrismaService } from "../src/prisma/prisma.service";
import { signUp, startApp } from "./helpers";

describe("page cache", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let alice: Awaited<ReturnType<typeof signUp>>;
  let aliceId: string;
  const otherUserId = `test-${crypto.randomUUID()}`;

  const cachePage = (userId: string, url: string, kind: "RESUME" | "SOURCE_LISTING") =>
    prisma.pageCache.create({ data: { userId, url, kind, content: "cached" } });

  beforeAll(async () => {
    app = await startApp();
    prisma = app.get(PrismaService);
    alice = await signUp(app.getHttpServer());
    const session = await alice.get("/api/auth/get-session").expect(200);
    aliceId = session.body.user.id;
  });

  afterAll(async () => {
    await prisma.pageCache.deleteMany({ where: { userId: { in: [aliceId, otherUserId] } } });
    await app.close();
  });

  it("rejects requests without a session", async () => {
    await request(app.getHttpServer()).delete("/api/cache").expect(401);
  });

  it("clears only the signed-in user's cached pages", async () => {
    await cachePage(aliceId, "https://example.com/cv.pdf", "RESUME");
    await cachePage(aliceId, "https://example.com/jobs", "SOURCE_LISTING");
    await cachePage(otherUserId, "https://example.com/jobs", "SOURCE_LISTING");

    const response = await alice.delete("/api/cache").expect(200);
    expect(response.body).toEqual({ deleted: 2 });

    expect(await prisma.pageCache.count({ where: { userId: aliceId } })).toBe(0);
    expect(await prisma.pageCache.count({ where: { userId: otherUserId } })).toBe(1);
  });

  it("succeeds when nothing is cached", async () => {
    const response = await alice.delete("/api/cache").expect(200);
    expect(response.body).toEqual({ deleted: 0 });
  });
});
