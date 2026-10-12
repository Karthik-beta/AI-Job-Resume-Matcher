import { Context, Data, Effect, Layer, Schema } from "effect";
import { firecrawlErrorFromStatus, ScrapeFailed } from "./errors";
import {
  type CloudProxy,
  cloudLimiter,
  Firecrawl,
  type FirecrawlError,
  type FirecrawlRequestFailed,
  firecrawlFrom,
  localLimiter,
  type MapOptions,
  makeBackend,
  type PageKind,
  type PageScrape,
  type ScrapeBackend,
  type ScrapeRequest,
  type ScrapeUsage,
  type SiteMap,
  sdkClient,
} from "./firecrawl";

export type FirecrawlMode = "cloud" | "local" | "hybrid";

export type FirecrawlConfig =
  | { readonly mode: "cloud"; readonly apiKey: string; readonly cloudProxy: CloudProxy }
  | { readonly mode: "local"; readonly localUrl: string }
  // Hybrid sends only blocked pages to the cloud, always with the "auto" proxy.
  | { readonly mode: "hybrid"; readonly apiKey: string; readonly localUrl: string };

const Mode = Schema.Literals(["cloud", "local", "hybrid"]);
const ProxyOption = Schema.Literals(["basic", "auto"]);

// Empty values count as unset, as `KEY=` lines in .env leave them.
const present = (value: string | undefined) => value?.trim() || undefined;

const isHttpUrl = (url: string) =>
  URL.canParse(url) && ["http:", "https:"].includes(new URL(url).protocol);

// Reads FIRECRAWL_MODE alone, for the fake providers, which need no key or URL.
export const firecrawlModeFrom = (env: Record<string, string | undefined>): FirecrawlMode => {
  const mode = present(env["FIRECRAWL_MODE"]);
  return mode === "local" || mode === "hybrid" ? mode : "cloud";
};

// Only the live providers read this, so fake runs need neither a key nor a local instance.
export const firecrawlConfigFrom = (env: Record<string, string | undefined>): FirecrawlConfig => {
  const mode = Schema.decodeUnknownOption(Mode)(present(env["FIRECRAWL_MODE"]) ?? "cloud");
  const cloudProxy = Schema.decodeUnknownOption(ProxyOption)(
    present(env["FIRECRAWL_CLOUD_PROXY"]) ?? "basic",
  );
  if (mode._tag === "None" || cloudProxy._tag === "None") {
    throw new Error(
      "FIRECRAWL_MODE must be cloud, local or hybrid, and FIRECRAWL_CLOUD_PROXY basic or auto.",
    );
  }
  return checkedConfig(mode.value, cloudProxy.value, env);
};

const checkedConfig = (
  mode: FirecrawlMode,
  cloudProxy: CloudProxy,
  env: Record<string, string | undefined>,
): FirecrawlConfig => {
  const apiKey = present(env["FIRECRAWL_API_KEY"]);
  const localUrl = present(env["FIRECRAWL_LOCAL_URL"])?.replace(/\/+$/, "");
  const missing = [
    mode !== "local" && !apiKey ? "FIRECRAWL_API_KEY" : null,
    mode !== "cloud" && !localUrl ? "FIRECRAWL_LOCAL_URL (e.g. http://localhost:3002)" : null,
  ].filter((name) => name !== null);
  if (missing.length > 0) {
    throw new Error(`FIRECRAWL_MODE=${mode} needs ${missing.join(" and ")}.`);
  }
  if (localUrl !== undefined && mode !== "cloud" && !isHttpUrl(localUrl)) {
    throw new Error(`FIRECRAWL_LOCAL_URL must be an http(s) URL, got "${localUrl}".`);
  }
  if (mode === "cloud") return { mode, apiKey: apiKey ?? "", cloudProxy };
  if (mode === "local") return { mode, localUrl: localUrl ?? "" };
  return { mode, apiKey: apiKey ?? "", localUrl: localUrl ?? "" };
};

export class LocalFirecrawlDown extends Data.TaggedError("LocalFirecrawlDown")<{
  readonly message: string;
}> {}

// Checked before a run scrapes anything, so a stopped local instance stops the run once
// instead of failing every job.
export class ScrapeHealth extends Context.Service<
  ScrapeHealth,
  { readonly check: Effect.Effect<void, LocalFirecrawlDown> }
>()("ScrapeHealth") {}

export const healthyScrapes = ScrapeHealth.of({ check: Effect.void });

const healthTimeoutMs = 3_000;

export const checkLocalFirecrawl = (localUrl: string, timeoutMs = healthTimeoutMs) =>
  Effect.tryPromise({
    try: (signal) =>
      fetch(`${localUrl}/v0/health/readiness`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      }).then((response) => response.ok),
    catch: () => false,
  }).pipe(
    Effect.orElseSucceed(() => false),
    Effect.flatMap((ok) =>
      ok
        ? Effect.void
        : Effect.fail(
            new LocalFirecrawlDown({ message: `Local Firecrawl is not running at ${localUrl}` }),
          ),
    ),
  );

const cloudCredits = (page: PageScrape["page"]) => page.metadata?.creditsUsed ?? 1;

// Cloud errors keep their stop rules: 401, 402 and 429 stop the run.
const cloudError = (error: FirecrawlRequestFailed): FirecrawlError =>
  error.status === null
    ? new ScrapeFailed(error)
    : firecrawlErrorFromStatus(error.status, error.message);

// A local instance has no credits or plan limits, so none of its errors stop the run: they
// fail the one page, and the run moves on to pages that may scrape fine.
const localError = (error: FirecrawlRequestFailed) =>
  new ScrapeFailed({ status: error.status, message: `Local Firecrawl: ${error.message}` });

export type RouterConfig =
  | { readonly mode: "cloud"; readonly cloud: ScrapeBackend; readonly cloudProxy: CloudProxy }
  | { readonly mode: "local"; readonly local: ScrapeBackend }
  | { readonly mode: "hybrid"; readonly cloud: ScrapeBackend; readonly local: ScrapeBackend };

const cloudScrape = (
  cloud: ScrapeBackend,
  url: string,
  request: ScrapeRequest,
  proxy: CloudProxy,
): Effect.Effect<PageScrape, FirecrawlError> =>
  cloud.scrape(url, { ...request, proxy }).pipe(
    Effect.mapError(cloudError),
    Effect.map((page) => ({ page, usage: { via: "cloud", credits: cloudCredits(page) } })),
  );

const localScrape = (
  local: ScrapeBackend,
  url: string,
  request: ScrapeRequest,
): Effect.Effect<PageScrape, ScrapeFailed> =>
  local.scrape(url, request).pipe(
    Effect.mapError(localError),
    Effect.map((page) => ({ page, usage: { via: "local", credits: 0 } })),
  );

// /map costs one credit per call.
const cloudMap = (cloud: ScrapeBackend, url: string, options: MapOptions) =>
  cloud.map(url, options).pipe(
    Effect.mapError(cloudError),
    Effect.map(({ links }): SiteMap => ({ links, usage: { via: "cloud", credits: 1 } })),
  );

const localMap = (local: ScrapeBackend, url: string, options: MapOptions) =>
  local.map(url, options).pipe(
    Effect.mapError(localError),
    Effect.map(({ links }): SiteMap => ({ links, usage: { via: "local", credits: 0 } })),
  );

const logUsage = (url: string, { usage }: { readonly usage: ScrapeUsage }) =>
  Effect.logDebug(`Scraped ${url} via ${usage.via} (${usage.credits} credits)`);

// Implements the Firecrawl service over the instances FIRECRAWL_MODE selects.
export const makeScrapeRouter = (config: RouterConfig) => {
  const scrape = (
    url: string,
    request: ScrapeRequest,
    _kind: PageKind,
  ): Effect.Effect<PageScrape, FirecrawlError> => {
    switch (config.mode) {
      case "cloud":
        return cloudScrape(config.cloud, url, request, config.cloudProxy);
      case "local":
        return localScrape(config.local, url, request);
      case "hybrid":
        return localScrape(config.local, url, request).pipe(
          Effect.catch(() => cloudScrape(config.cloud, url, request, "auto")),
        );
    }
  };

  const map = (url: string, options: MapOptions): Effect.Effect<SiteMap, FirecrawlError> => {
    switch (config.mode) {
      case "cloud":
        return cloudMap(config.cloud, url, options);
      case "local":
        return localMap(config.local, url, options);
      case "hybrid":
        return localMap(config.local, url, options).pipe(
          Effect.catch(() => cloudMap(config.cloud, url, options)),
        );
    }
  };

  return firecrawlFrom({
    scrape: (url, request, kind) =>
      scrape(url, request, kind).pipe(Effect.tap((r) => logUsage(url, r))),
    map: (url, options) => map(url, options).pipe(Effect.tap((r) => logUsage(url, r))),
  });
};

const cloudBackend = (apiKey: string) =>
  Effect.map(cloudLimiter, (limiter) => makeBackend("cloud", sdkClient({ apiKey }), limiter));

// A self-hosted instance without database authentication needs no key, and an empty one
// keeps the SDK from sending FIRECRAWL_API_KEY to it.
const localBackend = (apiUrl: string) =>
  Effect.map(localLimiter, (limiter) =>
    makeBackend("local", sdkClient({ apiKey: "", apiUrl }), limiter),
  );

// Firecrawl routed per FIRECRAWL_MODE, with the local instance's health check.
export const firecrawlLayer = (config: FirecrawlConfig) =>
  Layer.mergeAll(
    Layer.effect(
      Firecrawl,
      Effect.gen(function* () {
        switch (config.mode) {
          case "cloud":
            return makeScrapeRouter({
              mode: "cloud",
              cloud: yield* cloudBackend(config.apiKey),
              cloudProxy: config.cloudProxy,
            });
          case "local":
            return makeScrapeRouter({ mode: "local", local: yield* localBackend(config.localUrl) });
          case "hybrid":
            return makeScrapeRouter({
              mode: "hybrid",
              cloud: yield* cloudBackend(config.apiKey),
              local: yield* localBackend(config.localUrl),
            });
        }
      }),
    ),
    Layer.succeed(
      ScrapeHealth,
      config.mode === "cloud"
        ? healthyScrapes
        : ScrapeHealth.of({ check: checkLocalFirecrawl(config.localUrl) }),
    ),
  );
