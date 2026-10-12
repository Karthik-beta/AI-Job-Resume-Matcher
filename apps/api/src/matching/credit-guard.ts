import type { SourceKind } from "@job-matcher/shared";
import { Clock, Effect, Ref } from "effect";
import type { CreditUsage, Listing } from "./firecrawl";
import { isCached } from "./page-cache";
import { type CloudBudget, type FirecrawlMode, FirecrawlPlan } from "./scrape-router";
import type { ListingSource } from "./sources/adapter";
import { descriptionReader } from "./sources/registry";

// The Firecrawl credit guard. A cloud or hybrid run reads the plan's credits once, after the
// preflight, and may spend what is left above FIRECRAWL_CREDIT_RESERVE. The user's scheduled
// runs share one allowance per UTC day, an even share of that per day left in the billing
// period: each scheduled run gets the share less what the day's earlier scheduled runs spent,
// so a frequent schedule cannot spend the month in a day. A manual run may use more than a
// day's share, never the reserve, and does not count against the scheduled runs' share.
// Every cloud request is counted from its reported usage, with no further API calls.

const dayMs = 86_400_000;

// A search costs 2 credits per 10 results (https://docs.firecrawl.dev/billing), and a search
// source asks for 10 (see searchCost in scrape-router.ts).
export const searchCredits = 2;

export interface CreditAllowance {
  // The plan's credits when the run started.
  readonly remaining: number;
  // Credits above the reserve.
  readonly usable: number;
  // What this run may spend: all of `usable`, or what is left of today's scheduled share.
  readonly limit: number;
  readonly periodEnd: Date;
}

// The end Firecrawl reports, or the end of the calendar month (UTC) when it reports none.
export const periodEndOf = (usage: CreditUsage, now: number) => {
  const reported = usage.billingPeriodEnd ? Date.parse(usage.billingPeriodEnd) : Number.NaN;
  if (!Number.isNaN(reported)) return new Date(reported);
  const today = new Date(now);
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
};

// Whole days left in the period, counting today.
export const daysLeft = (periodEnd: Date, now: number) =>
  Math.max(1, Math.ceil((periodEnd.getTime() - now) / dayMs));

// Midnight (UTC) at the start of the day `now` falls in: the scheduled runs' day.
export const startOfUtcDay = (now: number) => new Date(now - (now % dayMs));

// `spentToday`: the cloud credits the user's other scheduled runs spent since startOfUtcDay.
export const allowanceOf = (
  usage: CreditUsage,
  reserve: number,
  scheduled: boolean,
  now: number,
  spentToday = 0,
): CreditAllowance => {
  const periodEnd = periodEndOf(usage, now);
  const usable = Math.max(0, usage.remainingCredits - reserve);
  const limit = scheduled
    ? Math.max(0, Math.floor(usable / daysLeft(periodEnd, now)) - spentToday)
    : usable;
  return { remaining: usage.remainingCredits, usable, limit, periodEnd };
};

export const limitMessage = (allowance: CreditAllowance, spent: number) => {
  const left = Math.max(0, allowance.remaining - spent);
  const until = allowance.periodEnd.toISOString().slice(0, 10);
  const what =
    allowance.limit < allowance.usable
      ? "Firecrawl daily credit allowance reached"
      : "Firecrawl credit reserve reached";
  return `${what} (${left} left until ${until})`;
};

// One run's cloud credits: what it may spend and what it has spent. Without an allowance
// (local mode, or before the plan is read) nothing is refused, but spending is still counted.
export const makeRunCredits = Effect.gen(function* () {
  const state = yield* Ref.make<{
    readonly allowance: CreditAllowance | null;
    readonly spent: number;
  }>({ allowance: null, spent: 0 });
  const budget: CloudBudget = {
    allows: (credits) =>
      Effect.map(
        Ref.get(state),
        ({ allowance, spent }) => allowance === null || spent + credits <= allowance.limit,
      ),
    spent: (credits) =>
      Ref.update(state, (current) => ({ ...current, spent: current.spent + credits })),
    refusal: Effect.map(Ref.get(state), ({ allowance, spent }) =>
      allowance ? limitMessage(allowance, spent) : "Firecrawl credit reserve reached",
    ),
  };
  return {
    budget,
    spent: Effect.map(Ref.get(state), ({ spent }) => spent),
    // Credits the run may still spend; null when it is not limited.
    left: Effect.map(Ref.get(state), ({ allowance, spent }) =>
      allowance ? Math.max(0, allowance.limit - spent) : null,
    ),
    // Reads the plan's credits; null in local mode. `spentToday` is what the user's other
    // scheduled runs spent today (see allowanceOf).
    start: (scheduled: boolean, spentToday = 0) =>
      Effect.gen(function* () {
        const plan = yield* FirecrawlPlan;
        const usage = yield* plan.creditUsage;
        if (usage === null) return null;
        const allowance = allowanceOf(
          usage,
          plan.creditReserve,
          scheduled,
          yield* Clock.currentTimeMillis,
          spentToday,
        );
        yield* Ref.update(state, (current) => ({ ...current, allowance }));
        return allowance;
      }),
  };
});

export type RunCredits = Effect.Success<typeof makeRunCredits>;

// The cloud credits reading a source's listings will take, as far as can be told up front:
// none for a cached source or an ATS API, a page source's first page (and its map) in cloud
// mode, and a search on the cloud in either mode. Local scrapes in hybrid mode count as free.
export const sourceCredits = (userId: string, source: ListingSource, mode: FirecrawlMode) =>
  Effect.gen(function* () {
    if (mode === "local") return 0;
    const estimate =
      source.kind === "SEARCH"
        ? searchCredits
        : source.kind === "PAGE" && mode === "cloud"
          ? 1 + (source.useMap ? 1 : 0)
          : 0;
    if (estimate === 0) return 0;
    const cached = yield* isCached({ userId, url: source.url, kind: "SOURCE_LISTING" });
    return cached ? 0 : estimate;
  });

// A job's cloud credits: none when its ad comes with the listing, from the source's API or
// from the cache, otherwise one scrape in cloud mode. Hybrid counts its local scrapes as
// free; the budget still decides whether a blocked page may go to the cloud.
export const jobCredits = (
  userId: string,
  listing: Listing,
  kind: SourceKind,
  mode: FirecrawlMode,
) =>
  Effect.gen(function* () {
    if (mode !== "cloud" || listing.description !== undefined) return 0;
    if (descriptionReader(kind, listing.url)) return 0;
    const cached = yield* isCached({ userId, url: listing.url, kind: "JOB_PAGE" });
    return cached ? 0 : 1;
  });

// The jobs, in order, whose credits fit; free jobs always do.
export const fitJobs = <A>(jobs: readonly A[], credits: readonly number[], available: number) => {
  let left = available;
  return jobs.filter((_, index) => {
    const cost = credits[index] ?? 0;
    if (cost > left) return false;
    left -= cost;
    return true;
  });
};
