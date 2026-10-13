import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { defaultSettings } from "@job-matcher/shared";
import { PrismaService } from "../src/prisma/prisma.service";

const migration = join(
  import.meta.dir,
  "../../../prisma/migrations/20261013075002_onboarding_state/migration.sql",
);

// The migration's backfill statement: everything after its "-- Backfill" comment.
const backfillSql = async () => {
  const sql = await Bun.file(migration).text();
  const start = sql.indexOf("-- Backfill");
  expect(start).toBeGreaterThan(-1);
  return sql.slice(start).trim().replace(/;$/, "");
};

class Rollback extends Error {}

describe("onboarding backfill migration", () => {
  const prisma = new PrismaService();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Runs in a transaction that is rolled back, so the shared database is left as it was.
  it("completes onboarding for every user with a run, and no one else", async () => {
    const id = () => `test-${crypto.randomUUID()}`;
    const [noRow, pending, done, noRun, nothing, deleted] = [id(), id(), id(), id(), id(), id()];
    const earlier = new Date("2026-01-01T00:00:00.000Z");
    const sql = await backfillSql();

    const outcome = prisma.$transaction(async (tx) => {
      // The transaction's time, which CURRENT_TIMESTAMP reports, within the column's rounding.
      const now = (await tx.$queryRaw<[{ now: Date }]>`SELECT CURRENT_TIMESTAMP AS now`)[0].now;
      const isNow = (date: Date | null | undefined) =>
        date != null && Math.abs(date.getTime() - now.getTime()) <= 1;
      const run = (userId: string) => ({ userId, trigger: "MANUAL" as const, contextKey: "test" });
      // Every user but `deleted` exists; its run is left over from a deleted account.
      await tx.user.createMany({
        data: [noRow, pending, done, noRun, nothing].map((userId) => ({
          id: userId,
          name: "Test",
          email: `${userId}@example.com`,
          updatedAt: now,
        })),
      });
      await tx.run.createMany({
        data: [run(noRow), run(pending), run(pending), run(done), run(deleted)],
      });
      await tx.settings.createMany({
        data: [
          { userId: pending, resumeUrl: "https://example.com/cv.pdf", locations: ["Remote"] },
          { userId: done, locations: [], onboardingCompletedAt: earlier },
          { userId: noRun, locations: [] },
        ],
      });

      await tx.$executeRawUnsafe(sql);

      const rows = await tx.settings.findMany({
        where: { userId: { in: [noRow, pending, done, noRun, nothing, deleted] } },
      });
      const byUser = new Map(rows.map((row) => [row.userId, row]));

      // A user without settings gets the row a save of the defaults would create.
      const created = byUser.get(noRow);
      if (!created) throw new Error("No settings row was created");
      const { userId: _, onboardingCompletedAt, onboardingDismissedAt, ...settings } = created;
      expect(settings).toEqual({ ...defaultSettings } as typeof settings);
      expect(isNow(onboardingCompletedAt)).toBe(true);
      expect(onboardingDismissedAt).toBeNull();

      // Existing settings keep their values and gain the completion time.
      expect(byUser.get(pending)).toMatchObject({
        resumeUrl: "https://example.com/cv.pdf",
        locations: ["Remote"],
      });
      expect(isNow(byUser.get(pending)?.onboardingCompletedAt)).toBe(true);
      // An earlier completion is kept.
      expect(byUser.get(done)?.onboardingCompletedAt).toEqual(earlier);
      // Users without runs are left alone.
      expect(byUser.get(noRun)?.onboardingCompletedAt).toBeNull();
      expect(byUser.has(nothing)).toBe(false);
      // A run whose user was deleted creates no row.
      expect(byUser.has(deleted)).toBe(false);

      throw new Rollback();
    });

    await expect(outcome).rejects.toBeInstanceOf(Rollback);
    expect(await prisma.settings.count({ where: { userId: { in: [noRow, pending, done] } } })).toBe(
      0,
    );
  });
});
