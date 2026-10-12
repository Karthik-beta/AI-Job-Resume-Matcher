import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import {
  allowanceOf,
  daysLeft,
  fitJobs,
  jobCredits,
  limitMessage,
  makeRunCredits,
  periodEndOf,
  sourceCredits,
  startOfUtcDay,
} from "./credit-guard";
import type { CreditUsage, Listing } from "./firecrawl";
import { type CachedPage, PageCacheStore, type PageKey } from "./page-cache";
import { FirecrawlPlan } from "./scrape-router";

const at = (iso: string) => new Date(iso).getTime();
const usage = (remainingCredits: number, billingPeriodEnd: string | null): CreditUsage => ({
  remainingCredits,
  billingPeriodEnd,
});

describe("billing period", () => {
  test("uses the reported end, or the end of the calendar month when none is ahead", () => {
    const now = at("2026-10-12T09:00:00Z");
    expect(periodEndOf(usage(1, "2026-10-20T00:00:00Z"), now)).toEqual(
      new Date("2026-10-20T00:00:00Z"),
    );
    expect(periodEndOf(usage(1, null), now)).toEqual(new Date("2026-11-01T00:00:00Z"));
    expect(periodEndOf(usage(1, "not a date"), now)).toEqual(new Date("2026-11-01T00:00:00Z"));
    expect(periodEndOf(usage(1, "2026-10-01T00:00:00Z"), now)).toEqual(
      new Date("2026-11-01T00:00:00Z"),
    );
    expect(periodEndOf(usage(1, null), at("2026-12-31T23:00:00Z"))).toEqual(
      new Date("2027-01-01T00:00:00Z"),
    );
  });

  test("counts the days left, rounding up, and at least one", () => {
    const end = new Date("2026-10-20T00:00:00Z");
    expect(daysLeft(end, at("2026-10-12T09:00:00Z"))).toBe(8);
    expect(daysLeft(end, at("2026-10-19T23:00:00Z"))).toBe(1);
    expect(daysLeft(end, at("2026-10-21T00:00:00Z"))).toBe(1);
  });
});

describe("allowanceOf", () => {
  const now = at("2026-10-12T00:00:00Z");
  const plan = usage(450, "2026-10-22T00:00:00Z");

  test("lets a manual run spend everything above the reserve", () => {
    expect(allowanceOf(plan, 50, false, now)).toMatchObject({
      remaining: 450,
      usable: 400,
      limit: 400,
    });
  });

  test("gives a scheduled run its share per day left", () => {
    expect(allowanceOf(plan, 50, true, now).limit).toBe(40);
  });

  test("gives a scheduled run what the day's earlier scheduled runs left of the share", () => {
    expect(allowanceOf(plan, 50, true, now, 15).limit).toBe(25);
    expect(allowanceOf(plan, 50, true, now, 40).limit).toBe(0);
    expect(allowanceOf(plan, 50, true, now, 60).limit).toBe(0);
    // Manual runs are not limited by the scheduled share.
    expect(allowanceOf(plan, 50, false, now, 40).limit).toBe(400);
    expect(limitMessage(allowanceOf(plan, 50, true, now, 40), 0)).toBe(
      "Firecrawl daily credit allowance reached (450 left until 2026-10-22)",
    );
  });

  test("starts the scheduled runs' day at midnight UTC", () => {
    expect(startOfUtcDay(at("2026-10-12T23:59:59Z"))).toEqual(new Date("2026-10-12T00:00:00Z"));
    expect(startOfUtcDay(at("2026-10-13T00:00:00Z"))).toEqual(new Date("2026-10-13T00:00:00Z"));
  });

  test("allows nothing inside the reserve", () => {
    expect(allowanceOf(usage(30, null), 50, false, now)).toMatchObject({ usable: 0, limit: 0 });
  });

  test("names the reserve or the daily share in its message", () => {
    const manual = allowanceOf(plan, 50, false, now);
    expect(limitMessage(manual, 400)).toBe(
      "Firecrawl credit reserve reached (50 left until 2026-10-22)",
    );
    expect(limitMessage(allowanceOf(plan, 50, true, now), 40)).toBe(
      "Firecrawl daily credit allowance reached (410 left until 2026-10-22)",
    );
  });
});

describe("makeRunCredits", () => {
  const planLayer = (creditUsage: CreditUsage | null) =>
    Layer.succeed(
      FirecrawlPlan,
      FirecrawlPlan.of({
        mode: creditUsage ? "cloud" : "local",
        creditReserve: 50,
        creditUsage: Effect.succeed(creditUsage),
      }),
    );

  test("paces a scheduled run by the clock and refuses requests past its share", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(at("2026-10-12T12:00:00Z"));
      const credits = yield* makeRunCredits;
      expect(yield* credits.budget.allows(1_000)).toBe(true);
      // 250 above the reserve, with 5 days (rounded up) to go: 50 today.
      const allowance = yield* credits.start(true);
      expect(allowance).toMatchObject({ usable: 250, limit: 50 });
      yield* credits.budget.spent(49);
      expect(yield* credits.left).toBe(1);
      expect(yield* credits.budget.allows(1)).toBe(true);
      expect(yield* credits.budget.allows(2)).toBe(false);
      yield* credits.budget.spent(1);
      expect(yield* credits.spent).toBe(50);
      expect(yield* credits.budget.refusal).toBe(
        "Firecrawl daily credit allowance reached (250 left until 2026-10-17)",
      );
    }).pipe(
      Effect.provide(Layer.merge(TestClock.layer(), planLayer(usage(300, "2026-10-17T00:00:00Z")))),
      Effect.runPromise,
    ));

  test("gives a scheduled run only what today's earlier scheduled runs left", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(at("2026-10-12T12:00:00Z"));
      const credits = yield* makeRunCredits;
      // 50 today, 45 of it already spent by earlier scheduled runs.
      expect(yield* credits.start(true, 45)).toMatchObject({ usable: 250, limit: 5 });
      expect(yield* credits.budget.allows(5)).toBe(true);
      expect(yield* credits.budget.allows(6)).toBe(false);
      // On the next day the share is whole again, and smaller with fewer days left.
      yield* TestClock.setTime(at("2026-10-13T00:30:00Z"));
      const tomorrow = yield* makeRunCredits;
      expect(yield* tomorrow.start(true, 0)).toMatchObject({ limit: 62 });
    }).pipe(
      Effect.provide(Layer.merge(TestClock.layer(), planLayer(usage(300, "2026-10-17T00:00:00Z")))),
      Effect.runPromise,
    ));

  test("limits nothing without a cloud plan, but still counts", () =>
    Effect.gen(function* () {
      const credits = yield* makeRunCredits;
      expect(yield* credits.start(false)).toBeNull();
      yield* credits.budget.spent(3);
      expect(yield* credits.left).toBeNull();
      expect(yield* credits.spent).toBe(3);
      expect(yield* credits.budget.allows(1_000)).toBe(true);
      expect(yield* credits.budget.refusal).toBe("Firecrawl credit reserve reached");
    }).pipe(Effect.provide(planLayer(null)), Effect.runPromise));
});

describe("estimates", () => {
  const cachedUrls = new Set(["https://cached.example.com/jobs", "https://jobs.example.com/2"]);
  const store = PageCacheStore.of({
    get: ({ url }: PageKey) =>
      Effect.succeed<CachedPage | null>(
        cachedUrls.has(url) ? { content: [], expiresAt: null } : null,
      ),
    set: () => Effect.void,
  });
  const run = <A>(effect: Effect.Effect<A, never, PageCacheStore>) =>
    effect.pipe(Effect.provideService(PageCacheStore, store), Effect.runPromise);

  const page = (url: string, useMap = false) =>
    ({ url, kind: "PAGE", adapterKey: null, useMap }) as const;

  test("counts the sources' cloud reads", async () => {
    const search = { url: "search:engineer", kind: "SEARCH", adapterKey: null } as const;
    const ats = { url: "https://jobs.lever.co/acme", kind: "LEVER", adapterKey: "acme" } as const;
    const estimates = await run(
      Effect.all([
        sourceCredits("alice", page("https://acme.com/careers"), "cloud"),
        sourceCredits("alice", page("https://acme.com/careers", true), "cloud"),
        sourceCredits("alice", page("https://cached.example.com/jobs"), "cloud"),
        sourceCredits("alice", page("https://acme.com/careers"), "hybrid"),
        sourceCredits("alice", search, "hybrid"),
        sourceCredits("alice", ats, "cloud"),
        sourceCredits("alice", search, "local"),
      ]),
    );
    expect(estimates).toEqual([1, 2, 0, 0, 2, 0, 0]);
  });

  test("counts a scrape for each job without its ad", async () => {
    const job = (url: string): Listing => ({
      title: "Engineer",
      url,
      company: "Acme",
      locations: [],
      experienceMinYears: null,
      experienceMaxYears: null,
      remote: null,
      postedAt: null,
    });
    const estimates = await run(
      Effect.all([
        jobCredits("alice", job("https://jobs.example.com/1"), "PAGE", "cloud"),
        jobCredits("alice", job("https://jobs.example.com/2"), "PAGE", "cloud"),
        jobCredits("alice", { ...job("https://x.com/1"), description: "Ad" }, "PAGE", "cloud"),
        jobCredits(
          "alice",
          job("https://jobs.smartrecruiters.com/a/1"),
          "SMARTRECRUITERS",
          "cloud",
        ),
        jobCredits("alice", job("https://jobs.example.com/1"), "PAGE", "hybrid"),
      ]),
    );
    expect(estimates).toEqual([1, 0, 0, 0, 0]);
  });

  test("keeps the jobs that fit, in order, and every free one", () => {
    expect(fitJobs(["a", "b", "c", "d"], [1, 1, 0, 1], 1)).toEqual(["a", "c"]);
    expect(fitJobs(["a", "b"], [1, 1], 0)).toEqual([]);
  });
});
