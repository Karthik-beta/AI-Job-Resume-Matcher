import { afterAll, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { prismaScrapeRouteStore } from "../src/matching/scrape-routes";
import { PrismaService } from "../src/prisma/prisma.service";

describe("ScrapeRoute store", () => {
  const prisma = new PrismaService();
  const store = prismaScrapeRouteStore(prisma);
  const domain = `test-${crypto.randomUUID()}.example.com`;
  const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect);

  afterAll(async () => {
    await prisma.scrapeRoute.deleteMany({ where: { domain } });
    await prisma.$disconnect();
  });

  it("counts local blocks, keeps the cloud preference and resets on success", async () => {
    expect(await run(store.get(domain))).toBeNull();
    // A success on a site that never blocked writes nothing.
    await run(store.localWorked(domain));
    expect(await prisma.scrapeRoute.count({ where: { domain } })).toBe(0);

    expect(await run(store.addLocalBlock(domain))).toBe(1);
    expect(await run(store.addLocalBlock(domain))).toBe(2);
    const until = new Date("2030-01-08T00:00:00Z");
    await run(store.preferCloud(domain, until));
    expect(await run(store.get(domain))).toEqual({ localBlocks: 2, preferCloudUntil: until });

    await run(store.localWorked(domain));
    expect(await run(store.get(domain))).toEqual({ localBlocks: 0, preferCloudUntil: null });
  });
});
