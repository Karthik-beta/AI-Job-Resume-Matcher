import { afterAll, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { prismaPageCacheStore } from "../src/matching/page-cache";
import { PrismaService } from "../src/prisma/prisma.service";

describe("page cache store", () => {
  const userId = `test-${crypto.randomUUID()}`;
  const key = { userId, url: "https://example.com/jobs", kind: "SOURCE_LISTING" } as const;
  const prisma = new PrismaService();

  afterAll(async () => {
    await prisma.pageCache.deleteMany({ where: { userId } });
    await prisma.$disconnect();
  });

  it("returns null for a page that was never cached", async () => {
    expect(await Effect.runPromise(prismaPageCacheStore(prisma).get(key))).toBeNull();
  });

  it("keeps pages across clients and overwrites on a later write", async () => {
    const expiresAt = new Date("2026-01-01T00:15:00Z");
    await Effect.runPromise(prismaPageCacheStore(prisma).set(key, [{ title: "Old" }], null));
    await Effect.runPromise(prismaPageCacheStore(prisma).set(key, [{ title: "New" }], expiresAt));

    const restarted = new PrismaService();
    try {
      const page = await Effect.runPromise(prismaPageCacheStore(restarted).get(key));
      expect(page).toEqual({ content: [{ title: "New" }], expiresAt });
    } finally {
      await restarted.$disconnect();
    }
  });

  it("does not return another user's page", async () => {
    const other = { ...key, userId: `${userId}-other` };
    expect(await Effect.runPromise(prismaPageCacheStore(prisma).get(other))).toBeNull();
  });
});
