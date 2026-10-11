import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PrismaService } from "../src/prisma/prisma.service";
import { createScheduledRun } from "../src/runs/create-run";

describe("scheduled runs", () => {
  const prisma = new PrismaService();
  const userId = `test-${crypto.randomUUID()}`;
  const model = "example/model";

  beforeAll(async () => {
    await prisma.jobSource.createMany({
      data: [
        { userId, url: "https://board.example.com/a" },
        { userId, url: "https://board.example.com/b" },
      ],
    });
  });

  afterAll(async () => {
    await prisma.run.deleteMany({ where: { userId } });
    await prisma.jobSource.deleteMany({ where: { userId } });
    await prisma.settings.deleteMany({ where: { userId } });
    await prisma.$disconnect();
  });

  it("skips a tick before the user has a resume", async () => {
    expect(await createScheduledRun(prisma, userId, model)).toBeNull();
  });

  it("creates a SCHEDULED run over all of the user's sources", async () => {
    await prisma.settings.create({ data: { userId, resumeUrl: "https://example.com/cv.pdf" } });
    const sources = await prisma.jobSource.findMany({ where: { userId }, select: { id: true } });

    const run = await createScheduledRun(prisma, userId, model);
    expect(run).toMatchObject({ trigger: "SCHEDULED", status: "QUEUED" });
    expect([...(run?.sourceIds ?? [])].sort()).toEqual(sources.map(({ id }) => id).sort());
  });

  it("skips a tick while a run is active", async () => {
    expect(await createScheduledRun(prisma, userId, model)).toBeNull();
    expect(await prisma.run.count({ where: { userId } })).toBe(1);
  });
});
