import { FirecrawlClient, type JsonFormat, SdkError } from "@mendable/firecrawl-js";
import { Clock, Context, Duration, Effect, Layer, Ref, Schema } from "effect";
import { FirecrawlBlocked, firecrawlErrorFromStatus, ScrapeFailed } from "./errors";
import { retryAfterMs } from "./retry-after";

// Ten requests a minute on the free plan, with a small timing margin.
const requestSpacingMs = 6_100;
const rateLimitRetries = 2;
// The SDK does not expose response headers, so the hint comes from the 429 message.
const retryHintPattern = /retry after (\d+(?:\.\d+)?)s/i;

export interface Listing {
  readonly title: string;
  readonly url: string;
  readonly company: string;
  readonly locations: readonly string[];
  readonly experienceMinYears: number | null;
  readonly experienceMaxYears: number | null;
}

export interface ScrapedPage {
  readonly markdown?: string | undefined;
  readonly json?: unknown;
}

export type ScrapeFormat = "markdown" | JsonFormat;

export type ScrapePage = (url: string, format: ScrapeFormat) => Effect.Effect<ScrapedPage, unknown>;

type FirecrawlError = FirecrawlBlocked | ScrapeFailed;

export class Firecrawl extends Context.Service<
  Firecrawl,
  {
    readonly scrapeMarkdown: (url: string) => Effect.Effect<string, FirecrawlError>;
    readonly scrapeListings: (
      sourceUrl: string,
    ) => Effect.Effect<readonly Listing[], FirecrawlError>;
  }
>()("Firecrawl") {}

const listingsPrompt =
  "Extract only individual job listings explicitly present on this page. " +
  "Copy their titles and companies and return actual job-detail URLs, " +
  "resolving relative links against the source URL. Exclude navigation, " +
  "search pages and company profiles. Extract locations and minimum/maximum " +
  "years of experience only when explicitly stated for that listing. " +
  "Use an empty locations list and null experience bounds when unstated. " +
  "For '3+ years', use minimum 3 and maximum null. Do not invent jobs " +
  "or infer location or experience from titles.";

const yearsJsonSchema = (description: string) => ({
  anyOf: [{ type: "number", minimum: 0 }, { type: "null" }],
  description,
});

export const listingsJsonSchema = {
  type: "object",
  properties: {
    jobs: {
      type: "array",
      description: "List of job postings",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Job title" },
          url: { type: "string", description: "URL of the job posting" },
          company: { type: "string", description: "Company name" },
          locations: {
            type: "array",
            items: { type: "string" },
            description: "Job locations explicitly stated in the listing; empty if unstated",
          },
          experience_min_years: yearsJsonSchema(
            "Minimum required years of experience explicitly stated; null if unstated",
          ),
          experience_max_years: yearsJsonSchema(
            "Maximum years of experience explicitly stated; null for open-ended or unstated requirements",
          ),
        },
        required: ["title", "url", "company"],
      },
    },
  },
  required: ["jobs"],
};

const listingsFormat: JsonFormat = {
  type: "json",
  prompt: listingsPrompt,
  schema: listingsJsonSchema,
};

const Years = Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(null)),
);

const ListingsJson = Schema.Struct({
  jobs: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      url: Schema.String,
      company: Schema.String,
      locations: Schema.Array(Schema.String).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed([])),
      ),
      experience_min_years: Years,
      experience_max_years: Years,
    }),
  ),
});

const decodeListings = Schema.decodeUnknownEffect(ListingsJson);

const isRateLimited = (cause: unknown): cause is SdkError =>
  cause instanceof SdkError && cause.status === 429;

const toFirecrawlError = (cause: unknown): FirecrawlError => {
  if (cause instanceof SdkError && cause.status !== undefined) {
    return firecrawlErrorFromStatus(cause.status, cause.message);
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return new ScrapeFailed({ status: null, message });
};

export const makeFirecrawl = (scrape: ScrapePage) =>
  Effect.gen(function* () {
    const nextRequestAt = yield* Ref.make(0);

    // Each caller reserves the next slot before sleeping, so concurrent requests stay spaced.
    const waitForTurn = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const delay = yield* Ref.modify(nextRequestAt, (next) => {
        const start = Math.max(now, next);
        return [start - now, start + requestSpacingMs] as const;
      });
      if (delay > 0) yield* Effect.sleep(Duration.millis(delay));
    });

    const backOff = (error: SdkError) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const delay = retryAfterMs(retryHintPattern.exec(error.message)?.[1]);
        yield* Ref.update(nextRequestAt, (next) => Math.max(next, now + delay));
      });

    const request = (url: string, format: ScrapeFormat) =>
      waitForTurn.pipe(
        Effect.andThen(scrape(url, format)),
        Effect.tapError((cause) => (isRateLimited(cause) ? backOff(cause) : Effect.void)),
        Effect.mapError(toFirecrawlError),
        Effect.retry({
          times: rateLimitRetries,
          while: (error) => error._tag === "FirecrawlBlocked" && error.status === 429,
        }),
      );

    return Firecrawl.of({
      scrapeMarkdown: (url) =>
        request(url, "markdown").pipe(
          Effect.flatMap(({ markdown }) =>
            markdown?.trim()
              ? Effect.succeed(markdown)
              : Effect.fail(
                  new ScrapeFailed({
                    status: null,
                    message: "Firecrawl returned no document markdown.",
                  }),
                ),
          ),
        ),
      scrapeListings: (sourceUrl) =>
        request(sourceUrl, listingsFormat).pipe(
          Effect.flatMap(({ json }) =>
            decodeListings(json).pipe(
              Effect.mapError(
                (error) =>
                  new ScrapeFailed({
                    status: null,
                    message: `Firecrawl returned invalid listings: ${error.message}`,
                  }),
              ),
            ),
          ),
          Effect.map(({ jobs }) =>
            jobs.map((job) => ({
              title: job.title,
              url: job.url,
              company: job.company,
              locations: job.locations,
              experienceMinYears: job.experience_min_years,
              experienceMaxYears: job.experience_max_years,
            })),
          ),
        ),
    });
  });

export const firecrawlLayer = (apiKey: string) => {
  // The SDK counts attempts, not retries, so 1 turns its own retries off.
  const client = new FirecrawlClient({ apiKey, maxRetries: 1 });
  return Layer.effect(
    Firecrawl,
    makeFirecrawl((url, format) =>
      Effect.tryPromise({
        try: () => client.scrape(url, { formats: [format] }),
        catch: (cause) => cause,
      }),
    ),
  );
};
