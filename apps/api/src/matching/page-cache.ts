import { Clock, Context, Duration, Effect, Layer, Option, Schema } from "effect";
import type { CacheKind, Prisma, PrismaClient } from "../generated/prisma/client";
import { Firecrawl, Listing } from "./firecrawl";

const listingsTtl = Duration.minutes(15);

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

// A missing, expired or unreadable row counts as a miss. Failed scrapes are never stored.
const cached = <A extends Prisma.InputJsonValue, E, R>(
  key: PageKey,
  decode: (content: unknown) => Option.Option<A>,
  ttl: Duration.Duration | null,
  scrape: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const store = yield* PageCacheStore;
    const hit = yield* store.get(key);
    const now = yield* Clock.currentTimeMillis;
    if (hit && (hit.expiresAt === null || hit.expiresAt.getTime() > now)) {
      const content = decode(hit.content);
      if (Option.isSome(content)) return content.value;
    }
    const value = yield* scrape;
    // Scrapes can wait on the rate limit, so the expiry starts once the page arrives.
    const scrapedAt = yield* Clock.currentTimeMillis;
    const expiresAt = ttl === null ? null : new Date(scrapedAt + Duration.toMillis(ttl));
    yield* store.set(key, value, expiresAt);
    return value;
  });

const decodeMarkdown = Schema.decodeUnknownOption(Schema.String);
const decodeListings = Schema.decodeUnknownOption(Schema.Array(Listing));

const cachedMarkdown = (userId: string, url: string, kind: "RESUME" | "JOB_PAGE") =>
  Effect.gen(function* () {
    const firecrawl = yield* Firecrawl;
    return yield* cached(
      { userId, url, kind },
      decodeMarkdown,
      null,
      firecrawl.scrapeMarkdown(url),
    );
  });

export const scrapeResume = (userId: string, url: string) => cachedMarkdown(userId, url, "RESUME");

export const scrapeJobPage = (userId: string, url: string) =>
  cachedMarkdown(userId, url, "JOB_PAGE");

export const scrapeSourceListings = (userId: string, url: string) =>
  Effect.gen(function* () {
    const firecrawl = yield* Firecrawl;
    return yield* cached(
      { userId, url, kind: "SOURCE_LISTING" },
      decodeListings,
      listingsTtl,
      firecrawl.scrapeListings(url),
    );
  });
