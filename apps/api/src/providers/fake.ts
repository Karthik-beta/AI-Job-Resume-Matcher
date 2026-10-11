import { Effect, Layer, Schema } from "effect";
import { Notifier } from "../matching/discord";
import {
  FirecrawlBlocked,
  MatchOutputInvalid,
  OpenRouterAuthError,
  ScrapeFailed,
} from "../matching/errors";
import { MatchEvaluator } from "../matching/evaluate";
import { Firecrawl, Listing } from "../matching/firecrawl";

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
  scrapeMarkdown: (url) => scriptedError(url).pipe(Effect.andThen(readFixture(pagePath(url)))),
  scrapeListings: (url) =>
    scriptedError(url).pipe(
      Effect.andThen(readFixture("listings.json")),
      Effect.flatMap((text) => decodeListings(JSON.parse(text))),
      Effect.mapError((error) =>
        error._tag === "SchemaError"
          ? new ScrapeFailed({ status: null, message: "listings.json does not match Listing." })
          : error,
      ),
    ),
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
  notifyMatch: (_, alert) => Effect.logInfo(`Fake Discord alert for ${alert.jobUrl}`),
});

export const fakeProvidersLayer = Layer.mergeAll(
  Layer.succeed(Firecrawl, fakeFirecrawl),
  Layer.succeed(MatchEvaluator, fakeEvaluator),
  Layer.succeed(Notifier, fakeNotifier),
);
