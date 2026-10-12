import { FirecrawlClient, SdkError } from "@mendable/firecrawl-js";
import { Clock, Context, Data, Duration, Effect, Ref, Schema } from "effect";
import type { FirecrawlBlocked } from "./errors";
import { ScrapeFailed } from "./errors";
import { retryAfterMs } from "./retry-after";

const cloudRequestSpacingMs = 6_100;
const localRequestSpacingMs = 2_000;
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

export type Via = "local" | "cloud";

// Where a scrape ran and the Firecrawl credits it used (always 0 locally).
export interface ScrapeUsage {
  readonly via: Via;
  readonly credits: number;
}

export interface ScrapedPage {
  readonly markdown?: string | undefined;
  readonly rawHtml?: string | undefined;
  readonly links?: readonly string[] | undefined;
  readonly metadata?:
    | {
        readonly title?: string | undefined;
        readonly ogSiteName?: string | undefined;
        // The target page's HTTP status, which Firecrawl reports with the page.
        readonly statusCode?: number | undefined;
        readonly creditsUsed?: number | undefined;
      }
    | undefined;
}

export type ScrapeFormat = "markdown" | "rawHtml" | "links";

export interface ScrapeRequest {
  readonly formats: readonly ScrapeFormat[];
  readonly includeTags?: string[];
  readonly excludeTags?: string[];
  // Cloud only: "auto" retries with enhanced proxies when the basic one is blocked.
  readonly proxy?: CloudProxy;
}

export type CloudProxy = "basic" | "auto";

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

export interface MarkdownPage {
  readonly markdown: string;
  readonly usage: ScrapeUsage;
}

export interface JobPageScrape {
  readonly markdown: string;
  // For the page's schema.org JobPosting data; see job-posting.ts.
  readonly rawHtml: string | null;
  readonly usage: ScrapeUsage;
}

export interface ListingPage {
  readonly markdown: string;
  readonly links: readonly string[];
  // Only when requested, to look for an embedded ATS board.
  readonly rawHtml: string | null;
  readonly siteName: string | null;
  readonly usage: ScrapeUsage;
}

export interface SiteMap {
  readonly links: readonly MappedLink[];
  readonly usage: ScrapeUsage;
}

export type FirecrawlError = FirecrawlBlocked | ScrapeFailed;

// The cloud plan's credits (GET /v2/team/credit-usage); a null period end is unknown.
export interface CreditUsage {
  readonly remainingCredits: number;
  readonly billingPeriodEnd: string | null;
}

// Firecrawl, wherever it runs (see scrape-router.ts for cloud, local and hybrid).
export class Firecrawl extends Context.Service<
  Firecrawl,
  {
    readonly scrapeMarkdown: (url: string) => Effect.Effect<MarkdownPage, FirecrawlError>;
    // A job ad's main content, with the page's HTML for its structured data.
    readonly scrapeJob: (url: string) => Effect.Effect<JobPageScrape, FirecrawlError>;
    readonly scrapeListingPage: (
      url: string,
      options?: { readonly selector?: string | null; readonly withHtml?: boolean },
    ) => Effect.Effect<ListingPage, FirecrawlError>;
    // The site's URLs, ordered by relevance to the search; one credit per call.
    readonly map: (url: string, options: MapOptions) => Effect.Effect<SiteMap, FirecrawlError>;
  }
>()("Firecrawl") {}

// A request one Firecrawl instance could not answer. `status` is the API's HTTP status, or
// null when the request never got a response (a timeout or a refused connection).
export class FirecrawlRequestFailed extends Data.TaggedError("FirecrawlRequestFailed")<{
  readonly status: number | null;
  readonly message: string;
}> {}

// One Firecrawl instance, behind its own rate limit.
export interface ScrapeBackend {
  readonly via: Via;
  readonly scrape: (
    url: string,
    request: ScrapeRequest,
  ) => Effect.Effect<ScrapedPage, FirecrawlRequestFailed>;
  readonly map: (
    url: string,
    options: MapOptions,
  ) => Effect.Effect<{ readonly links: readonly MappedLink[] }, FirecrawlRequestFailed>;
  // Only the cloud has credits; a local instance never asks.
  readonly creditUsage: Effect.Effect<CreditUsage, FirecrawlRequestFailed>;
}

export interface ScrapeClient {
  readonly scrape: ScrapePage;
  readonly map: MapSite;
  readonly creditUsage: Effect.Effect<CreditUsage, unknown>;
}

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

export interface Limiter {
  readonly waitForTurn: (url: string) => Effect.Effect<void>;
  readonly backOff: (url: string, delayMs: number) => Effect.Effect<void>;
}

// Spaces the requests that share a key. Each caller reserves the next slot before sleeping,
// so concurrent requests stay spaced.
export const makeLimiter = (spacingMs: number, keyOf: (url: string) => string) =>
  Effect.gen(function* () {
    const nextRequestAt = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    return {
      waitForTurn: (url) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const key = keyOf(url);
          const delay = yield* Ref.modify(nextRequestAt, (next) => {
            const start = Math.max(now, next.get(key) ?? 0);
            return [start - now, new Map(next).set(key, start + spacingMs)] as const;
          });
          if (delay > 0) yield* Effect.sleep(Duration.millis(delay));
        }),
      backOff: (url, delayMs) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const key = keyOf(url);
          yield* Ref.update(nextRequestAt, (next) =>
            new Map(next).set(key, Math.max(next.get(key) ?? 0, now + delayMs)),
          );
        }),
    } satisfies Limiter;
  });

export const hostOf = (url: string) => (URL.canParse(url) ? new URL(url).hostname : url);

// The cloud plan allows ten requests a minute, with a small timing margin.
export const cloudLimiter = makeLimiter(cloudRequestSpacingMs, () => "cloud");
// A local instance has no plan limit; pages on one site stay politely spaced instead.
export const localLimiter = makeLimiter(localRequestSpacingMs, hostOf);

const toRequestFailed = (cause: unknown) => {
  if (cause instanceof SdkError) {
    return new FirecrawlRequestFailed({ status: cause.status ?? null, message: cause.message });
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return new FirecrawlRequestFailed({ status: null, message });
};

export const makeBackend = (via: Via, client: ScrapeClient, limiter: Limiter): ScrapeBackend => {
  const rateLimited = <A>(url: string, call: Effect.Effect<A, unknown>) =>
    limiter.waitForTurn(url).pipe(
      Effect.andThen(call),
      Effect.mapError(toRequestFailed),
      Effect.tapError((error) =>
        error.status === 429
          ? limiter.backOff(url, retryAfterMs(retryHintPattern.exec(error.message)?.[1]))
          : Effect.void,
      ),
      Effect.retry({ times: rateLimitRetries, while: (error) => error.status === 429 }),
    );
  return {
    via,
    scrape: (url, request) => rateLimited(url, client.scrape(url, request)),
    map: (url, options) => rateLimited(url, client.map(url, options)),
    // The team endpoint is not a scrape, so it skips the scrape rate limit.
    creditUsage: client.creditUsage.pipe(Effect.mapError(toRequestFailed)),
  };
};

export interface PageScrape {
  readonly page: ScrapedPage;
  readonly usage: ScrapeUsage;
}

export type PageKind = "page" | "job";

// The service's methods over a router that picks the instance for each request.
export const firecrawlFrom = (route: {
  readonly scrape: (
    url: string,
    request: ScrapeRequest,
    kind: PageKind,
  ) => Effect.Effect<PageScrape, FirecrawlError>;
  readonly map: (url: string, options: MapOptions) => Effect.Effect<SiteMap, FirecrawlError>;
}) =>
  Firecrawl.of({
    scrapeMarkdown: (url) =>
      route
        .scrape(url, { formats: ["markdown"] }, "page")
        .pipe(
          Effect.flatMap(({ page, usage }) =>
            requireMarkdown(page).pipe(Effect.map((markdown) => ({ markdown, usage }))),
          ),
        ),
    // rawHtml adds no credits to the page's one (https://docs.firecrawl.dev/billing).
    scrapeJob: (url) =>
      route
        .scrape(url, { formats: ["markdown", "rawHtml"], excludeTags: chromeTags }, "job")
        .pipe(
          Effect.flatMap(({ page, usage }) =>
            requireMarkdown(page).pipe(
              Effect.map((markdown) => ({ markdown, rawHtml: page.rawHtml ?? null, usage })),
            ),
          ),
        ),
    // markdown, links and rawHtml together cost one credit.
    scrapeListingPage: (url, { selector = null, withHtml = false } = {}) =>
      route
        .scrape(
          url,
          {
            formats: withHtml ? ["markdown", "links", "rawHtml"] : ["markdown", "links"],
            excludeTags: chromeTags,
            ...(selector ? { includeTags: [selector] } : {}),
          },
          "page",
        )
        .pipe(
          Effect.map(({ page, usage }) => ({
            markdown: page.markdown ?? "",
            links: page.links ?? [],
            rawHtml: page.rawHtml ?? null,
            siteName: siteNameOf(page.metadata),
            usage,
          })),
        ),
    map: route.map,
  });

// The SDK client for one instance. Every scrape asks for the main content without ads or
// inline images; a PDF comes back as base64 for one credit instead of one per page (see
// pdfOrMarkdown).
export const sdkClient = (options: { readonly apiKey: string; readonly apiUrl?: string }) => {
  // The SDK counts attempts, not retries, so 1 turns its own retries off.
  const client = new FirecrawlClient({ ...options, maxRetries: 1 });
  return {
    scrape: (url, { formats, ...request }) =>
      Effect.tryPromise({
        try: () =>
          client.scrape(url, {
            ...request,
            formats: [...formats],
            onlyMainContent: true,
            blockAds: true,
            removeBase64Images: true,
            parsers: [],
          }),
        catch: (cause) => cause,
      }),
    map: (url, options) =>
      Effect.tryPromise({ try: () => client.map(url, { ...options }), catch: (cause) => cause }),
    creditUsage: Effect.tryPromise({
      try: () => client.getCreditUsage(),
      catch: (cause) => cause,
    }).pipe(
      Effect.map(({ remainingCredits, billingPeriodEnd }) => ({
        remainingCredits,
        billingPeriodEnd: billingPeriodEnd ?? null,
      })),
    ),
  } satisfies ScrapeClient;
};
