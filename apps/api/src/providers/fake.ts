import { isDiscordWebhookUrl } from "@job-matcher/shared";
import { Effect, Layer, Schema } from "effect";
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
import { Firecrawl, Listing } from "../matching/firecrawl";
import { ListingExtractor } from "../matching/listing-extractor";
import { PdfParser } from "../matching/pdf";
import { ResumeSource, sha256 } from "../matching/resume-source";
import { hostLimiterLayer } from "../matching/sources/http";
import { markdownLinks } from "../matching/sources/page-links";

const fixtures = new URL("../../test/fixtures/", import.meta.url);
const jobsHost = "jobs.example.com";
const decodeListings = Schema.decodeUnknownEffect(Schema.Array(Listing));

const readFixture = (path: string) =>
  Effect.tryPromise({
    try: () => Bun.file(new URL(path, fixtures)).text(),
    catch: () => new ScrapeFailed({ status: null, message: `No fixture for ${path}.` }),
  });

// `?fake-error=429` (or 401, 402) blocks Firecrawl; any other status fails just that scrape.
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

export const fakeFirecrawl = Firecrawl.of({
  scrapeMarkdown: (url) =>
    scriptedError(url).pipe(Effect.andThen(Effect.suspend(() => readFixture(pagePath(url))))),
  // The fixture job pages have no structured data.
  scrapeJob: (url) =>
    scriptedError(url).pipe(
      Effect.andThen(Effect.suspend(() => readFixture(pagePath(url)))),
      Effect.map((markdown) => ({ markdown, rawHtml: null })),
    ),
  // Every careers page serves the same board, whose links the fake extractor reads.
  scrapeListingPage: (url) =>
    scriptedError(url).pipe(
      Effect.andThen(readFixture("listing-page.md")),
      Effect.map((markdown) => ({
        markdown,
        links: markdownLinks(markdown).map((link) => link.url),
        rawHtml: null,
        siteName: null,
      })),
    ),
  // No map has job links, so sources that use one fall back to their page.
  map: (url) => scriptedError(url).pipe(Effect.as([])),
});

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

export const fakeNotifier = Notifier.of({
  notifyMatch: (webhookUrl, alert) =>
    isDiscordWebhookUrl(webhookUrl)
      ? Effect.logInfo(`Fake Discord alert for ${alert.jobUrl}`)
      : Effect.fail(new NotifyFailed({ message: "The webhook URL is not a Discord webhook." })),
});

export const fakeProvidersLayer = Layer.mergeAll(
  Layer.succeed(Firecrawl, fakeFirecrawl),
  Layer.succeed(ResumeSource, fakeResumeSource),
  Layer.succeed(HttpFetch, fakeHttpFetch),
  Layer.succeed(PdfParser, fakePdfParser),
  Layer.succeed(MatchEvaluator, fakeEvaluator),
  Layer.succeed(ListingExtractor, fakeListingExtractor),
  Layer.succeed(Notifier, fakeNotifier),
  hostLimiterLayer,
);
