import type { SourceKind } from "@job-matcher/shared";
import { Clock, Context, Duration, Effect, Layer, Option, Schema } from "effect";
import type { CacheKind, Prisma, PrismaClient } from "../generated/prisma/client";
import { HttpFetch, isSuccess } from "./download";
import { Firecrawl, Listing } from "./firecrawl";
import { JobPage, parseJobPosting } from "./job-posting";
import { isPdf, PdfParser, pdfOrMarkdown } from "./pdf";
import { type ListingSource, listingPage } from "./sources/adapter";
import type { DetectedSource } from "./sources/detect";
import { adapterFor, descriptionReader } from "./sources/registry";

const listingsTtl = Duration.minutes(15);
// A search costs credits and finds the past week's ads, so it runs at most once a day.
const searchListingsTtl = Duration.hours(24);

export interface PageKey {
  readonly userId: string;
  readonly url: string;
  readonly kind: CacheKind;
}

export interface CachedPage {
  readonly content: Prisma.JsonValue;
  readonly expiresAt: Date | null;
}

export class PageCacheStore extends Context.Service<
  PageCacheStore,
  {
    readonly get: (key: PageKey) => Effect.Effect<CachedPage | null>;
    readonly set: (
      key: PageKey,
      content: Prisma.InputJsonValue,
      expiresAt: Date | null,
    ) => Effect.Effect<void>;
  }
>()("PageCacheStore") {}

export const prismaPageCacheStore = (prisma: PrismaClient) =>
  PageCacheStore.of({
    get: (key) =>
      Effect.promise(() =>
        prisma.pageCache.findUnique({
          where: { userId_url_kind: key },
          select: { content: true, expiresAt: true },
        }),
      ),
    set: (key, content, expiresAt) =>
      Effect.promise(() =>
        prisma.pageCache.upsert({
          where: { userId_url_kind: key },
          create: { ...key, content, expiresAt },
          update: { content, expiresAt, createdAt: new Date() },
        }),
      ).pipe(Effect.asVoid),
  });

export const pageCacheStoreLayer = (prisma: PrismaClient) =>
  Layer.succeed(PageCacheStore, prismaPageCacheStore(prisma));

const isFresh = (hit: CachedPage | null, now: number) =>
  hit !== null && (hit.expiresAt === null || hit.expiresAt.getTime() > now);

// Whether a read of the key would be served from the cache, for the credit guard's estimates.
export const isCached = (key: PageKey) =>
  Effect.gen(function* () {
    const hit = yield* (yield* PageCacheStore).get(key);
    return isFresh(hit, yield* Clock.currentTimeMillis);
  });

// A missing, expired or unreadable row counts as a miss. An expired row is handed to the
// scrape, which may reuse it. Failed scrapes are never stored.
const cached = <A extends Prisma.InputJsonValue, E, R>(
  key: PageKey,
  decode: (content: unknown) => Option.Option<A>,
  ttl: Duration.Duration | null,
  scrape: (expired: A | null) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const store = yield* PageCacheStore;
    const hit = yield* store.get(key);
    const now = yield* Clock.currentTimeMillis;
    const content = hit ? Option.getOrNull(decode(hit.content)) : null;
    if (content !== null && (hit?.expiresAt === null || (hit?.expiresAt?.getTime() ?? 0) > now)) {
      return content;
    }
    const value = yield* scrape(content);
    // Scrapes can wait on the rate limit, so the expiry starts once the page arrives.
    const scrapedAt = yield* Clock.currentTimeMillis;
    const expiresAt = ttl === null ? null : new Date(scrapedAt + Duration.toMillis(ttl));
    yield* store.set(key, value, expiresAt);
    return value;
  });

// Job pages cached before their structured data was read hold only the markdown.
const decodeCachedJobPage = Schema.decodeUnknownOption(Schema.Union([JobPage, Schema.String]));
const decodeJobPage = (content: unknown): Option.Option<JobPage> =>
  decodeCachedJobPage(content).pipe(
    Option.map((page) => (typeof page === "string" ? { markdown: page, posting: null } : page)),
  );
const decodeListings = Schema.decodeUnknownOption(Schema.Array(Listing));

// A PDF job ad is parsed here, as Firecrawl bills a PDF per page. A failed HEAD or download,
// or a body that is not a PDF after all, falls back to Firecrawl.
const downloadPdf = (url: string) =>
  Effect.gen(function* () {
    const http = yield* HttpFetch;
    const isPdfPath = URL.canParse(url) && new URL(url).pathname.toLowerCase().endsWith(".pdf");
    if (!isPdfPath) {
      const head = yield* http.request(url, { method: "HEAD" }).pipe(Effect.option);
      const type = Option.getOrNull(head)?.headers.get("content-type") ?? "";
      if (!type.toLowerCase().startsWith("application/pdf")) return null;
    }
    const response = yield* http.request(url).pipe(Effect.option);
    if (Option.isNone(response)) return null;
    const { status, body } = response.value;
    return isSuccess(status) && isPdf(body) ? body : null;
  });

// How a job's text was read, as JobResult.scrapedVia records it; null for a downloaded PDF.
export type ScrapeVia = "ATS" | "CACHE" | "LOCAL" | "CLOUD";

interface ReadVia {
  via: ScrapeVia | null;
}

const fetchJobPage = (url: string, read: ReadVia = { via: null }) =>
  Effect.gen(function* () {
    read.via = null;
    const pdf = yield* downloadPdf(url);
    if (pdf) return { markdown: yield* (yield* PdfParser).parse(pdf), posting: null };
    const firecrawl = yield* Firecrawl;
    const { markdown, rawHtml, usage } = yield* firecrawl.scrapeJob(url);
    read.via = usage.via === "cloud" ? "CLOUD" : "LOCAL";
    return {
      markdown: yield* pdfOrMarkdown(markdown),
      posting: rawHtml ? parseJobPosting(rawHtml) : null,
    };
  });

const cachedJobPage = <E, R>(
  userId: string,
  url: string,
  read: () => Effect.Effect<JobPage, E, R>,
) => cached({ userId, url, kind: "JOB_PAGE" }, decodeJobPage, null, read);

export const scrapeJobPage = (userId: string, url: string) =>
  cachedJobPage(userId, url, () => fetchJobPage(url));

// Keyed by the source URL; changing a source's kind clears its row (see SourcesService.update).
// Only the listings are cached; an embedded board and the listing hash are reported by the
// scrape that found them. Expired listings are kept for a page source whose page is unchanged.
export const scrapeSourceListings = (userId: string, source: ListingSource) =>
  Effect.gen(function* () {
    const found: { embedded: DetectedSource | null; listingHash: string | null } = {
      embedded: null,
      listingHash: null,
    };
    const listings = yield* cached(
      { userId, url: source.url, kind: "SOURCE_LISTING" },
      decodeListings,
      source.kind === "SEARCH" ? searchListingsTtl : listingsTtl,
      (previous) =>
        adapterFor(source.kind)
          .fetchListings(source, previous)
          .pipe(
            Effect.map((fetched) => {
              found.embedded = fetched.embedded ?? null;
              found.listingHash = fetched.listingHash ?? null;
              return fetched.listings;
            }),
          ),
    );
    return { listings, ...found };
  });

const withDescription = (listing: Listing, description: string) =>
  listingPage({ ...listing, description });

// A listing that came with its job ad is not scraped. Otherwise the source's API supplies the
// ad when it can, and the page is scraped as a last resort; both are cached like job pages.
// `via` says which of these supplied the text.
export const jobPageFor = (userId: string, listing: Listing, kind: SourceKind) =>
  Effect.gen(function* () {
    if (listing.description !== undefined) {
      const markdown = withDescription(listing, listing.description);
      return { markdown, posting: null, via: "ATS" as ScrapeVia | null };
    }
    const fetchDescription = descriptionReader(kind, listing.url);
    // Left as CACHE when the cache answers without reading anything.
    const read: ReadVia = { via: "CACHE" };
    const page = fetchDescription
      ? yield* cachedJobPage(userId, listing.url, () =>
          fetchDescription(listing).pipe(
            Effect.map((text) => {
              read.via = "ATS";
              return { markdown: withDescription(listing, text), posting: null };
            }),
          ),
        )
      : yield* cachedJobPage(userId, listing.url, () => fetchJobPage(listing.url, read));
    return { ...page, via: read.via };
  });
