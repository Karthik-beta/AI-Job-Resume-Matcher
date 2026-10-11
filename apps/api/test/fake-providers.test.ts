import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { pageCacheStoreLayer } from "../src/matching/page-cache";
import { PrismaService } from "../src/prisma/prisma.service";
import { fakeProvidersLayer } from "../src/providers/fake";
import { processRun } from "../src/runs/process-run";

describe("fake providers", () => {
  const prisma = new PrismaService();
  const userId = `test-${crypto.randomUUID()}`;
  const layer = Layer.merge(fakeProvidersLayer, pageCacheStoreLayer(prisma));

  const runOver = async (sourceUrl: string) => {
    const source = await prisma.jobSource.create({ data: { userId, url: sourceUrl } });
    const run = await prisma.run.create({
      data: { userId, trigger: "MANUAL", contextKey: sourceUrl, sourceIds: [source.id] },
    });
    await Effect.runPromise(processRun(prisma, run.id).pipe(Effect.provide(layer)));
    return prisma.run.findUniqueOrThrow({ where: { id: run.id }, include: { results: true } });
  };

  beforeAll(async () => {
    await prisma.settings.create({
      data: { userId, resumeUrl: "https://example.com/cv.pdf", experienceYears: 4 },
    });
  });

  afterAll(async () => {
    await prisma.run.deleteMany({ where: { userId } });
    await prisma.match.deleteMany({ where: { userId } });
    await prisma.pageCache.deleteMany({ where: { userId } });
    await prisma.jobSource.deleteMany({ where: { userId } });
    await prisma.settings.deleteMany({ where: { userId } });
    await prisma.$disconnect();
  });

  it("runs the pipeline on the fixtures", async () => {
    const run = await runOver("https://board.example.com/jobs");

    expect(run).toMatchObject({ status: "COMPLETED", found: 3, eligible: 2, checked: 2 });
    const verdicts = Object.fromEntries(run.results.map((r) => [r.jobUrl, r.isMatch]));
    expect(verdicts).toEqual({
      "https://jobs.example.com/backend-payments": true,
      "https://jobs.example.com/full-stack": true,
    });
    expect(await prisma.match.count({ where: { userId } })).toBe(2);
  });

  it("stops the run on a scripted Firecrawl 429", async () => {
    const run = await runOver("https://board.example.com/jobs?fake-error=429");
    expect(run).toMatchObject({ status: "STOPPED", stopReason: "Scripted Firecrawl error 429." });
  });

  it("blocks requests to real providers", async () => {
    expect(fetch("https://api.firecrawl.dev/v2/scrape")).rejects.toThrow("Tests must not call");
  });
});
