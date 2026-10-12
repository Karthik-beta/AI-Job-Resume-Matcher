import { Clock, Context, Duration, Effect, Layer } from "effect";
import type { PrismaClient } from "../generated/prisma/client";

export interface ScrapeRoute {
  readonly localBlocks: number;
  readonly preferCloudUntil: Date | null;
}

// What hybrid mode remembers about each site (the ScrapeRoute table).
export class ScrapeRouteStore extends Context.Service<
  ScrapeRouteStore,
  {
    readonly get: (domain: string) => Effect.Effect<ScrapeRoute | null>;
    // Adds a local block and returns the count of consecutive ones.
    readonly addLocalBlock: (domain: string) => Effect.Effect<number>;
    readonly preferCloud: (domain: string, until: Date) => Effect.Effect<void>;
    readonly localWorked: (domain: string) => Effect.Effect<void>;
  }
>()("ScrapeRouteStore") {}

export const prismaScrapeRouteStore = (prisma: PrismaClient) =>
  ScrapeRouteStore.of({
    get: (domain) =>
      Effect.promise(() =>
        prisma.scrapeRoute.findUnique({
          where: { domain },
          select: { localBlocks: true, preferCloudUntil: true },
        }),
      ),
    addLocalBlock: (domain) =>
      Effect.promise(() =>
        prisma.scrapeRoute.upsert({
          where: { domain },
          create: { domain, localBlocks: 1 },
          update: { localBlocks: { increment: 1 } },
          select: { localBlocks: true },
        }),
      ).pipe(Effect.map(({ localBlocks }) => localBlocks)),
    preferCloud: (domain, until) =>
      Effect.promise(() =>
        prisma.scrapeRoute.update({ where: { domain }, data: { preferCloudUntil: until } }),
      ).pipe(Effect.asVoid),
    // Most sites never block, so a success writes only when there is a count to reset.
    localWorked: (domain) =>
      Effect.promise(() =>
        prisma.scrapeRoute.updateMany({
          where: { domain, localBlocks: { gt: 0 } },
          data: { localBlocks: 0, preferCloudUntil: null },
        }),
      ).pipe(Effect.asVoid),
  });

export const scrapeRouteStoreLayer = (prisma: PrismaClient) =>
  Layer.succeed(ScrapeRouteStore, prismaScrapeRouteStore(prisma));

// For tests and the fake providers.
export const memoryScrapeRouteStore = () => {
  const routes = new Map<string, ScrapeRoute>();
  const store = ScrapeRouteStore.of({
    get: (domain) => Effect.sync(() => routes.get(domain) ?? null),
    addLocalBlock: (domain) =>
      Effect.sync(() => {
        const route = routes.get(domain) ?? { localBlocks: 0, preferCloudUntil: null };
        routes.set(domain, { ...route, localBlocks: route.localBlocks + 1 });
        return route.localBlocks + 1;
      }),
    preferCloud: (domain, until) =>
      Effect.sync(() => {
        const route = routes.get(domain) ?? { localBlocks: 0, preferCloudUntil: null };
        routes.set(domain, { ...route, preferCloudUntil: until });
      }),
    localWorked: (domain) =>
      Effect.sync(() => {
        if (routes.has(domain)) routes.set(domain, { localBlocks: 0, preferCloudUntil: null });
      }),
  });
  return { routes, store };
};

export const localBlocksBeforeCloud = 2;
export const preferCloudFor = Duration.days(7);

export const prefersCloud = (store: ScrapeRouteStore["Service"], domain: string) =>
  Effect.gen(function* () {
    const route = yield* store.get(domain);
    const now = yield* Clock.currentTimeMillis;
    return (route?.preferCloudUntil?.getTime() ?? 0) > now;
  });

// After two blocks in a row the site goes straight to the cloud for a week, then local is
// tried again. The count is kept until a local success, so one more block sends it back.
export const noteLocalBlock = (store: ScrapeRouteStore["Service"], domain: string) =>
  Effect.gen(function* () {
    const blocks = yield* store.addLocalBlock(domain);
    if (blocks < localBlocksBeforeCloud) return;
    const now = yield* Clock.currentTimeMillis;
    yield* store.preferCloud(domain, new Date(now + Duration.toMillis(preferCloudFor)));
  });
