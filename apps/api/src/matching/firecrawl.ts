import { FirecrawlClient, SdkError } from "@mendable/firecrawl-js";
import { Clock, Context, Duration, Effect, Layer, Ref, Schema } from "effect";
import { FirecrawlBlocked, firecrawlErrorFromStatus, ScrapeFailed } from "./errors";
import { retryAfterMs } from "./retry-after";

// Ten requests a minute on the free plan, with a small timing margin.
const requestSpacingMs = 6_100;
const rateLimitRetries = 2;
// The SDK does not expose response headers, so the hint comes from the 429 message.
const retryHintPattern = /retry after (\d+(?:\.\d+)?)s/i;

export const Listing = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
  company: Schema.String,
  locations: Schema.Array(Schema.String),
  experienceMinYears: Schema.NullOr(Schema.Number),
  experienceMaxYears: Schema.NullOr(Schema.Number),
  // The defaults keep listings cached before these fields existed readable.
  remote: Schema.NullOr(Schema.Boolean).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  postedAt: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  // The job ad's text, when the source returns it with the listing.
  description: Schema.optionalKey(Schema.String),
});

export type Listing = typeof Listing.Type;

export interface ScrapedPage {
  readonly markdown?: string | undefined;
  readonly rawHtml?: string | undefined;
  readonly links?: readonly string[] | undefined;
  readonly metadata?:
    | { readonly title?: string | undefined; readonly ogSiteName?: string | undefined }
    | undefined;
}

export type ScrapeFormat = "markdown" | "rawHtml" | "links";

export interface ScrapeRequest {
  readonly formats: readonly ScrapeFormat[];
  readonly onlyMainContent?: boolean;
  readonly includeTags?: string[];
  readonly excludeTags?: string[];
}

export type ScrapePage = (
  url: string,
  request: ScrapeRequest,
) => Effect.Effect<ScrapedPage, unknown>;

export interface MappedLink {
  readonly url: string;
  readonly title?: string | undefined;
}

export interface MapOptions {
  readonly search: string;
  readonly limit: number;
}

export type MapSite = (
  url: string,
  options: MapOptions,
) => Effect.Effect<{ readonly links: readonly MappedLink[] }, unknown>;

export interface JobPageScrape {
  readonly markdown: string;
  // For the page's schema.org JobPosting data; see job-posting.ts.
  readonly rawHtml: string | null;
}

export interface ListingPage {
  readonly markdown: string;
  readonly links: readonly string[];
  // Only when requested, to look for an embedded ATS board.
  readonly rawHtml: string | null;
  readonly siteName: string | null;
}

type FirecrawlError = FirecrawlBlocked | ScrapeFailed;

export class Firecrawl extends Context.Service<
  Firecrawl,
  {
    readonly scrapeMarkdown: (url: string) => Effect.Effect<string, FirecrawlError>;
    // A job ad's main content, with the page's HTML for its structured data.
    readonly scrapeJob: (url: string) => Effect.Effect<JobPageScrape, FirecrawlError>;
    readonly scrapeListingPage: (
      url: string,
      options?: { readonly selector?: string | null; readonly withHtml?: boolean },
    ) => Effect.Effect<ListingPage, FirecrawlError>;
    // The site's URLs, ordered by relevance to the search; one credit per call.
    readonly map: (
      url: string,
      options: MapOptions,
    ) => Effect.Effect<readonly MappedLink[], FirecrawlError>;
  }
>()("Firecrawl") {}

// Page chrome that holds links but no listings.
const chromeTags = ["nav", "header", "footer", "aside", "form", "script", "style"];

// "Careers | Acme" names the site after its last separator.
const siteNameOf = (metadata: ScrapedPage["metadata"]) => {
  const name =
    metadata?.ogSiteName?.trim() ||
    metadata?.title
      ?.split(/\s[|–—-]\s/)
      .at(-1)
      ?.trim();
  return name || null;
};

const requireMarkdown = ({ markdown }: ScrapedPage): Effect.Effect<string, ScrapeFailed> =>
  markdown?.trim()
    ? Effect.succeed(markdown)
    : Effect.fail(
        new ScrapeFailed({ status: null, message: "Firecrawl returned no document markdown." }),
      );

const isRateLimited = (cause: unknown): cause is SdkError =>
  cause instanceof SdkError && cause.status === 429;

const toFirecrawlError = (cause: unknown): FirecrawlError => {
  if (cause instanceof SdkError && cause.status !== undefined) {
    return firecrawlErrorFromStatus(cause.status, cause.message);
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return new ScrapeFailed({ status: null, message });
};

export const makeFirecrawl = (client: { readonly scrape: ScrapePage; readonly map: MapSite }) =>
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

    const rateLimited = <A>(call: Effect.Effect<A, unknown>) =>
      waitForTurn.pipe(
        Effect.andThen(call),
        Effect.tapError((cause) => (isRateLimited(cause) ? backOff(cause) : Effect.void)),
        Effect.mapError(toFirecrawlError),
        Effect.retry({
          times: rateLimitRetries,
          while: (error) => error._tag === "FirecrawlBlocked" && error.status === 429,
        }),
      );

    const request = (url: string, scrapeRequest: ScrapeRequest) =>
      rateLimited(client.scrape(url, scrapeRequest));

    return Firecrawl.of({
      scrapeMarkdown: (url) =>
        request(url, { formats: ["markdown"] }).pipe(Effect.flatMap(requireMarkdown)),
      // rawHtml adds no credits to the page's one (https://docs.firecrawl.dev/billing).
      scrapeJob: (url) =>
        request(url, {
          formats: ["markdown", "rawHtml"],
          onlyMainContent: true,
          excludeTags: chromeTags,
        }).pipe(
          Effect.flatMap((page) =>
            requireMarkdown(page).pipe(
              Effect.map((markdown) => ({ markdown, rawHtml: page.rawHtml ?? null })),
            ),
          ),
        ),
      // markdown, links and rawHtml together cost one credit.
      scrapeListingPage: (url, { selector = null, withHtml = false } = {}) =>
        request(url, {
          formats: withHtml ? ["markdown", "links", "rawHtml"] : ["markdown", "links"],
          onlyMainContent: true,
          excludeTags: chromeTags,
          ...(selector ? { includeTags: [selector] } : {}),
        }).pipe(
          Effect.map((page) => ({
            markdown: page.markdown ?? "",
            links: page.links ?? [],
            rawHtml: page.rawHtml ?? null,
            siteName: siteNameOf(page.metadata),
          })),
        ),
      map: (url, options) =>
        rateLimited(client.map(url, options)).pipe(Effect.map(({ links }) => links)),
    });
  });

export const firecrawlLayer = (apiKey: string) => {
  // The SDK counts attempts, not retries, so 1 turns its own retries off.
  const client = new FirecrawlClient({ apiKey, maxRetries: 1 });
  return Layer.effect(
    Firecrawl,
    makeFirecrawl({
      scrape: (url, request) =>
        Effect.tryPromise({
          // A PDF comes back as base64 for one credit instead of one per page (see pdfOrMarkdown).
          try: () => client.scrape(url, { ...request, formats: [...request.formats], parsers: [] }),
          catch: (cause) => cause,
        }),
      map: (url, options) =>
        Effect.tryPromise({ try: () => client.map(url, { ...options }), catch: (cause) => cause }),
    }),
  );
};
