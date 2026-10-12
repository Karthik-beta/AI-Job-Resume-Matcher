import { isDiscordWebhookUrl } from "@job-matcher/shared";
import { Clock, Effect, Layer, Schema } from "effect";
import { Notifier } from "../matching/discord";
import { HttpFetch } from "../matching/download";
import {
  FirecrawlBlocked,
  MatchOutputInvalid,
  NotifyFailed,
  OpenRouterAuthError,
  ScrapeFailed,
} from "../matching/errors";
import { MatchEvaluator } from "../matching/evaluate";
import {
  FirecrawlRequestFailed,
  Listing,
  type ScrapeBackend,
  type ScrapedPage,
  type ScrapeRequest,
  type SearchResult,
  type Via,
} from "../matching/firecrawl";
import { ListingExtractor } from "../matching/listing-extractor";
import { PdfParser } from "../matching/pdf";
import { ResumeSource, sha256 } from "../matching/resume-source";
import {
  creditReserveFrom,
  type FirecrawlMode,
  firecrawlModeFrom,
  healthyScrapes,
  localSearchFrom,
  type RouterConfig,
  routerContext,
  ScrapeHealth,
} from "../matching/scrape-router";
import { memoryScrapeRouteStore } from "../matching/scrape-routes";
import { hostLimiterLayer } from "../matching/sources/http";
import { markdownLinks } from "../matching/sources/page-links";
import { TitleTriage } from "../matching/triage";

const fixtures = new URL("../../test/fixtures/", import.meta.url);
const jobsHost = "jobs.example.com";
const decodeListings = Schema.decodeUnknownEffect(Schema.Array(Listing));

const readFixture = (path: string) =>
  Effect.tryPromise({
    try: () => Bun.file(new URL(path, fixtures)).text(),
    catch: () => new ScrapeFailed({ status: null, message: `No fixture for ${path}.` }),
  });

// `?fake-error=429` (or 401, 402) blocks Firecrawl; any other status fails just that scrape.
// Firecrawl scrapes script the same errors, through the router's mapping (see fixturePage).
const scriptedError = (url: string): Effect.Effect<void, FirecrawlBlocked | ScrapeFailed> => {
  if (!URL.canParse(url))
    return Effect.fail(new ScrapeFailed({ status: null, message: "Invalid URL." }));
  const status = Number(new URL(url).searchParams.get("fake-error"));
  if (!status) return Effect.void;
  const message = `Scripted Firecrawl error ${status}.`;
  return [401, 402, 429].includes(status)
    ? Effect.fail(new FirecrawlBlocked({ status, message }))
    : Effect.fail(new ScrapeFailed({ status, message }));
};

const pagePath = (url: string) => {
  const { hostname, pathname } = new URL(url);
  return hostname === jobsHost ? `jobs${pathname}.md` : "resume.md";
};

// The fixture page for a scrape: careers pages (asked for links) all serve the same board,
// whose links the fake extractor reads. The fixture job pages have no structured data.
const fixturePage = (url: string, request: ScrapeRequest) =>
  Effect.gen(function* () {
    if (!URL.canParse(url)) {
      return yield* new FirecrawlRequestFailed({ status: null, message: "Invalid URL." });
    }
    const status = Number(new URL(url).searchParams.get("fake-error"));
    if (status) {
      return yield* new FirecrawlRequestFailed({
        status,
        message: `Scripted Firecrawl error ${status}.`,
      });
    }
    const listing = request.formats.includes("links");
    const markdown = yield* readFixture(listing ? "listing-page.md" : pagePath(url)).pipe(
      Effect.mapError((error) => new FirecrawlRequestFailed(error)),
    );
    return { markdown, links: listing ? markdownLinks(markdown).map((link) => link.url) : [] };
  });

// A bot check, as Cloudflare serves it to a scraper it blocks.
const challengePage: ScrapedPage = {
  markdown: "Just a moment...\n\nVerifying you are human. This may take a few seconds.",
  metadata: { title: "Just a moment...", statusCode: 403 },
};

export interface FakeCredits {
  readonly remainingCredits: number;
  // How far ahead the billing period ends; null leaves the end unknown.
  readonly periodDaysLeft: number | null;
}

const dayMs = 86_400_000;

// Every search finds the fixture job pages, as a search of ATS hosts would find job ads.
const searchResults: readonly SearchResult[] = [
  { url: "https://jobs.example.com/backend-payments", title: "Backend Engineer, Payments" },
  { url: "https://jobs.example.com/full-stack", title: "Full Stack Developer" },
].map((result) => ({ ...result, description: null }));
const defaultCredits: FakeCredits = { remainingCredits: 1_000, periodDaysLeft: 20 };

// Both instances serve the fixtures, except that `?fake-blocked` pages block the local one
// (so hybrid runs retry them on the cloud). No map has job links, so sources that use one
// fall back to their page. The cloud plan has the given credits left.
const fakeBackend = (via: Via, credits: FakeCredits = defaultCredits): ScrapeBackend => ({
  via,
  scrape: (url, request) =>
    via === "local" && URL.canParse(url) && new URL(url).searchParams.has("fake-blocked")
      ? Effect.succeed(challengePage)
      : fixturePage(url, request),
  map: (url) => fixturePage(url, { formats: [] }).pipe(Effect.as({ links: [] })),
  search: () => Effect.succeed({ results: searchResults }),
  creditUsage: Effect.map(Clock.currentTimeMillis, (now) => ({
    remainingCredits: credits.remainingCredits,
    billingPeriodEnd:
      credits.periodDaysLeft === null
        ? null
        : new Date(now + credits.periodDaysLeft * dayMs).toISOString(),
  })),
});

const fakeRouterConfig = (mode: FirecrawlMode, credits?: FakeCredits): RouterConfig => {
  switch (mode) {
    case "cloud":
      return { mode, cloud: fakeBackend("cloud", credits), cloudProxy: "basic" };
    case "local":
      return { mode, local: fakeBackend("local"), localSearch: localSearchFrom(process.env) };
    case "hybrid":
      return {
        mode,
        cloud: fakeBackend("cloud", credits),
        local: fakeBackend("local"),
        routes: memoryScrapeRouteStore().store,
      };
  }
};

// FIRECRAWL_MODE picks the fake instances, so each mode can be tried without Firecrawl.
export const fakeFirecrawlLayer = (
  mode: FirecrawlMode,
  options: { readonly credits?: FakeCredits; readonly creditReserve?: number } = {},
) =>
  Layer.mergeAll(
    Layer.succeedContext(
      routerContext(
        fakeRouterConfig(mode, options.credits),
        options.creditReserve ?? creditReserveFrom(process.env),
      ),
    ),
    Layer.succeed(ScrapeHealth, healthyScrapes),
  );

// The listings in listings.json, which name the fixture board's job pages.
export const fakeListingExtractor = ListingExtractor.of({
  extract: () =>
    Effect.tryPromise({
      try: () => Bun.file(new URL("listings.json", fixtures)).json(),
      catch: () => new MatchOutputInvalid({ message: "No listings.json fixture." }),
    }).pipe(
      Effect.flatMap(decodeListings),
      Effect.mapError(
        () => new MatchOutputInvalid({ message: "listings.json does not match Listing." }),
      ),
    ),
});

// Every resume URL serves the fixture resume, hashed like a scraped page.
export const fakeResumeSource = ResumeSource.of({
  resolve: (_userId, url) =>
    scriptedError(url).pipe(
      Effect.andThen(readFixture("resume.md")),
      Effect.map((text) => ({ text, hash: sha256(text) })),
    ),
});

// No HTTP in fake mode: job pages fall back to the Firecrawl fixtures.
export const fakeHttpFetch = HttpFetch.of({
  request: (url) =>
    Effect.fail(new ScrapeFailed({ status: null, message: `No fake HTTP for ${url}.` })),
});

export const fakePdfParser = PdfParser.of({
  parse: () => Effect.fail(new ScrapeFailed({ status: null, message: "No fake PDF parser." })),
});

// A job page's "Verdict:" line decides the outcome, so fixtures can script each case.
export const fakeEvaluator = MatchEvaluator.of({
  preflight: Effect.void,
  evaluate: ({ jobPage }) => {
    const verdict = /^Verdict: (.+)$/m.exec(jobPage)?.[1]?.trim();
    switch (verdict) {
      case "match":
        return Effect.succeed({ isMatch: true, reason: "The resume covers the listed stack." });
      case "auth":
        return Effect.fail(new OpenRouterAuthError({ status: 401, message: "Scripted 401." }));
      case "invalid":
        return Effect.fail(new MatchOutputInvalid({ message: "Scripted invalid output." }));
      default:
        return Effect.succeed({
          isMatch: false,
          reason: "The listing needs skills not on the resume.",
        });
    }
  },
});

// Every title is a strong fit, so triage keeps every job in listing order.
export const fakeTitleTriage = TitleTriage.of({
  score: ({ jobs }) => Effect.succeed(jobs.map(({ id }) => ({ id, score: 3, reason: null }))),
});

export const fakeNotifier = Notifier.of({
  notifyMatch: (webhookUrl, alert) =>
    isDiscordWebhookUrl(webhookUrl)
      ? Effect.logInfo(`Fake Discord alert for ${alert.jobUrl}`)
      : Effect.fail(new NotifyFailed({ message: "The webhook URL is not a Discord webhook." })),
});

export const fakeProvidersLayer = Layer.mergeAll(
  fakeFirecrawlLayer(firecrawlModeFrom(process.env)),
  Layer.succeed(ResumeSource, fakeResumeSource),
  Layer.succeed(HttpFetch, fakeHttpFetch),
  Layer.succeed(PdfParser, fakePdfParser),
  Layer.succeed(MatchEvaluator, fakeEvaluator),
  Layer.succeed(TitleTriage, fakeTitleTriage),
  Layer.succeed(ListingExtractor, fakeListingExtractor),
  Layer.succeed(Notifier, fakeNotifier),
  hostLimiterLayer,
);
