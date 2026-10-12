import { Context, Data, Effect, Layer, Schema } from "effect";
import { classifyScrape, type ScrapeOutcome, type ScrapeResult } from "./classify-scrape";
import { FirecrawlBlocked, firecrawlErrorFromStatus, ScrapeFailed } from "./errors";
import {
  type CloudProxy,
  type CreditUsage,
  cloudLimiter,
  Firecrawl,
  type FirecrawlError,
  type FirecrawlRequestFailed,
  firecrawlFrom,
  hostOf,
  localLimiter,
  makeBackend,
  type PageKind,
  type ScrapeBackend,
  type ScrapedPage,
  type ScrapeUsage,
  type SearchOptions,
  type SearchResults,
  sdkClient,
  type Via,
} from "./firecrawl";
import { noteLocalBlock, prefersCloud, ScrapeRouteStore } from "./scrape-routes";

export type FirecrawlMode = "cloud" | "local" | "hybrid";

export type FirecrawlConfig =
  | {
      readonly mode: "cloud";
      readonly apiKey: string;
      readonly cloudProxy: CloudProxy;
      readonly creditReserve: number;
    }
  // `localSearch`: the self-hosted instance searches through SearXNG (SEARXNG_ENDPOINT).
  | { readonly mode: "local"; readonly localUrl: string; readonly localSearch: boolean }
  // Hybrid sends only blocked pages to the cloud, always with the "auto" proxy.
  | {
      readonly mode: "hybrid";
      readonly apiKey: string;
      readonly localUrl: string;
      readonly creditReserve: number;
    };

// Credits a run leaves on the cloud plan (see credit-guard.ts).
const defaultCreditReserve = 50;

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

// FIRECRAWL_CREDIT_RESERVE, which the fake providers read too.
export const creditReserveFrom = (env: Record<string, string | undefined>) => {
  const value = present(env["FIRECRAWL_CREDIT_RESERVE"]);
  if (value === undefined) return defaultCreditReserve;
  if (!/^\d+$/.test(value)) {
    throw new Error(`FIRECRAWL_CREDIT_RESERVE must be a whole number of credits, got "${value}".`);
  }
  return Number(value);
};

// FIRECRAWL_LOCAL_SEARCH=true says the self-hosted instance has SEARXNG_ENDPOINT set.
export const localSearchFrom = (env: Record<string, string | undefined>) => {
  const value = present(env["FIRECRAWL_LOCAL_SEARCH"])?.toLowerCase();
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`FIRECRAWL_LOCAL_SEARCH must be true or false, got "${value}".`);
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
  if (mode === "local") {
    return { mode, localUrl: localUrl ?? "", localSearch: localSearchFrom(env) };
  }
  const creditReserve = creditReserveFrom(env);
  if (mode === "cloud") return { mode, apiKey: apiKey ?? "", cloudProxy, creditReserve };
  return { mode, apiKey: apiKey ?? "", localUrl: localUrl ?? "", creditReserve };
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

// The mode and cloud plan a run budgets its credits against (see credit-guard.ts).
export class FirecrawlPlan extends Context.Service<
  FirecrawlPlan,
  {
    readonly mode: FirecrawlMode;
    readonly creditReserve: number;
    // Null in local mode, which has no cloud plan.
    readonly creditUsage: Effect.Effect<CreditUsage | null, FirecrawlError>;
  }
>()("FirecrawlPlan") {}

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

// Firecrawl's billing counts enhanced and auto proxy requests as one credit, like basic
// ones (https://docs.firecrawl.dev/billing), so only a reported count changes the default.
const cloudCredits = (page: ScrapedPage) => page.metadata?.creditsUsed ?? 1;

// Cloud errors keep their stop rules: 401, 402 and 429 stop the run.
const cloudError = (error: FirecrawlRequestFailed): FirecrawlError =>
  error.status === null
    ? new ScrapeFailed(error)
    : firecrawlErrorFromStatus(error.status, error.message);

export const needsCloudMessage = "needs cloud; credit reserve reached";

export const localSearchMessage =
  "Search sources need cloud Firecrawl or SearXNG on your self-hosted Firecrawl " +
  "(set FIRECRAWL_LOCAL_SEARCH=true)";

// A search costs 2 credits per 10 results, rounded up (https://docs.firecrawl.dev/billing).
// The SDK drops the reported creditsUsed, so the cost is counted from the results.
export const searchCost = (results: number) => 2 * Math.ceil(results / 10);

// Whether a cloud request may be sent, and what each one cost. A run sets its own budget
// (see credit-guard.ts); outside a run only the plan itself (a 402) refuses requests.
export interface CloudBudget {
  // Whether a request that costs `credits` still fits.
  readonly allows: (credits: number) => Effect.Effect<boolean>;
  readonly spent: (credits: number) => Effect.Effect<void>;
  // Why a cloud-mode run stops once a request no longer fits.
  readonly refusal: Effect.Effect<string>;
}

export const unlimitedBudget: CloudBudget = {
  allows: () => Effect.succeed(true),
  spent: () => Effect.void,
  refusal: Effect.succeed("Firecrawl credit reserve reached"),
};

export const RunCloudBudget = Context.Reference<CloudBudget>("RunCloudBudget", {
  defaultValue: () => unlimitedBudget,
});

export type RouterConfig =
  | { readonly mode: "cloud"; readonly cloud: ScrapeBackend; readonly cloudProxy: CloudProxy }
  | { readonly mode: "local"; readonly local: ScrapeBackend; readonly localSearch?: boolean }
  | {
      readonly mode: "hybrid";
      readonly cloud: ScrapeBackend;
      readonly local: ScrapeBackend;
      readonly routes: ScrapeRouteStore["Service"];
    };

// One request (a scrape or a map) that the router can send to either instance.
interface Attempt<A> {
  readonly kind: PageKind | "map";
  readonly send: (
    backend: ScrapeBackend,
    proxy: CloudProxy | null,
  ) => Effect.Effect<A, FirecrawlRequestFailed>;
  // The page to classify; a map has none.
  readonly page: (value: A) => ScrapedPage;
  readonly cloudCredits: (value: A) => number;
  // The least a cloud request costs, checked against the run's budget before sending.
  readonly minCredits: number;
}

interface Routed<A> {
  readonly value: A;
  readonly usage: ScrapeUsage;
}

const failureOf = (result: ScrapeResult, outcome: ScrapeOutcome, via: Via) => {
  if ("error" in result) {
    const { status, message } = result.error;
    return new ScrapeFailed({
      status,
      message: via === "local" ? `Local Firecrawl: ${message}` : message,
    });
  }
  const status = result.page.metadata?.statusCode ?? null;
  const message =
    outcome === "gone"
      ? `The page is gone (HTTP ${status}).`
      : outcome === "failed"
        ? `The page returned HTTP ${status}.`
        : status !== null && status >= 400
          ? `The site blocked the ${via} scraper (HTTP ${status}).`
          : `The site served the ${via} scraper a bot check or a page without its content.`;
  return new ScrapeFailed({ status, message });
};

const sendCloud = <A>(
  cloud: ScrapeBackend,
  attempt: Attempt<A>,
  proxy: CloudProxy,
): Effect.Effect<Routed<A>, FirecrawlError> =>
  attempt.send(cloud, proxy).pipe(
    Effect.mapError(cloudError),
    Effect.map((value) => ({
      value,
      usage: { via: "cloud", credits: attempt.cloudCredits(value) },
    })),
  );

// A cloud request the run's budget allows, with its cost recorded. `refused` is the error
// when it does not fit.
const budgetedCloud = <A>(
  cloud: ScrapeBackend,
  attempt: Attempt<A>,
  proxy: CloudProxy,
  refused: (budget: CloudBudget) => Effect.Effect<never, FirecrawlError>,
) =>
  Effect.gen(function* () {
    const budget = yield* RunCloudBudget;
    if (!(yield* budget.allows(attempt.minCredits))) return yield* refused(budget);
    const sent = yield* sendCloud(cloud, attempt, proxy);
    yield* budget.spent(sent.usage.credits);
    return sent;
  });

// In cloud mode a refused request stops the run, like the plan's own 402.
const reserveReached = (budget: CloudBudget) =>
  Effect.flatMap(budget.refusal, (message) =>
    Effect.fail(new FirecrawlBlocked({ status: 402, message })),
  );

const needsCloud = () =>
  Effect.fail(new ScrapeFailed({ status: null, message: needsCloudMessage }));

// The local result, judged by classifyScrape. A local instance has no credits or plan
// limits, so none of its errors stop the run: they fail the one page.
const sendLocal = <A>(local: ScrapeBackend, attempt: Attempt<A>) =>
  attempt.send(local, null).pipe(
    Effect.result,
    Effect.map((sent) => {
      const result: ScrapeResult =
        sent._tag === "Success" ? { page: attempt.page(sent.success) } : { error: sent.failure };
      return { sent, result, outcome: classifyScrape(result, attempt.kind) };
    }),
  );

const localOnly = <A>(local: ScrapeBackend, attempt: Attempt<A>) =>
  sendLocal(local, attempt).pipe(
    Effect.flatMap(({ sent, result, outcome }) =>
      sent._tag === "Success" && outcome === "ok"
        ? Effect.succeed({ value: sent.success, usage: { via: "local", credits: 0 } as const })
        : Effect.fail(failureOf(result, outcome, "local")),
    ),
  );

// Local first; only a page the site blocked, or one the local instance could not answer, is
// retried on the cloud, once, with the auto proxy. A gone or failed page would fail there
// too. Sites that keep blocking the local instance go straight to the cloud for a while (see
// scrape-routes.ts).
const hybrid = <A>(
  config: Extract<RouterConfig, { mode: "hybrid" }>,
  url: string,
  attempt: Attempt<A>,
): Effect.Effect<Routed<A>, FirecrawlError> =>
  Effect.gen(function* () {
    const domain = hostOf(url);
    if (!(yield* prefersCloud(config.routes, domain))) {
      const { sent, result, outcome } = yield* sendLocal(config.local, attempt);
      if (sent._tag === "Success" && outcome === "ok") {
        yield* config.routes.localWorked(domain);
        return { value: sent.success, usage: { via: "local", credits: 0 } as const };
      }
      if (outcome !== "blocked" && outcome !== "unreachable") {
        return yield* failureOf(result, outcome, "local");
      }
      // Only the page's own evidence counts against the site: a local instance that is down
      // or failing must not send every domain to the cloud for a week.
      if (outcome === "blocked") yield* noteLocalBlock(config.routes, domain);
    }
    // Out of credits, the cloud refuses only the pages local cannot scrape, so the run goes on.
    const cloud = yield* budgetedCloud(config.cloud, attempt, "auto", needsCloud).pipe(
      Effect.catchIf(
        (error) => error._tag === "FirecrawlBlocked" && error.status === 402,
        () => Effect.fail(new ScrapeFailed({ status: 402, message: needsCloudMessage })),
      ),
    );
    const page = { page: attempt.page(cloud.value) };
    const cloudOutcome = classifyScrape(page, attempt.kind);
    if (cloudOutcome !== "ok") return yield* failureOf(page, cloudOutcome, "cloud");
    return cloud;
  });

// Searches go to the cloud in cloud and hybrid modes (a local instance searches only through
// SearXNG), within the run's budget like any other cloud request.
const cloudSearch = (
  cloud: ScrapeBackend,
  query: string,
  options: SearchOptions,
  refused: (budget: CloudBudget) => Effect.Effect<never, FirecrawlError>,
): Effect.Effect<SearchResults, FirecrawlError> =>
  Effect.gen(function* () {
    const budget = yield* RunCloudBudget;
    if (!(yield* budget.allows(searchCost(options.limit)))) return yield* refused(budget);
    const { results } = yield* cloud.search(query, options).pipe(Effect.mapError(cloudError));
    const credits = searchCost(results.length);
    yield* budget.spent(credits);
    return { results, usage: { via: "cloud", credits } };
  });

const localSearch = (
  config: Extract<RouterConfig, { mode: "local" }>,
  query: string,
  options: SearchOptions,
): Effect.Effect<SearchResults, FirecrawlError> =>
  config.localSearch
    ? config.local.search(query, options).pipe(
        Effect.map(({ results }) => ({ results, usage: { via: "local", credits: 0 } as const })),
        Effect.mapError(
          ({ status, message }) =>
            new ScrapeFailed({ status, message: `Local Firecrawl: ${message}` }),
        ),
      )
    : Effect.fail(new ScrapeFailed({ status: null, message: localSearchMessage }));

const logUsage = (url: string, { usage }: { readonly usage: ScrapeUsage }) =>
  Effect.logDebug(`Scraped ${url} via ${usage.via} (${usage.credits} credits)`);

// Implements the Firecrawl service over the instances FIRECRAWL_MODE selects.
export const makeScrapeRouter = (config: RouterConfig) => {
  const route = <A>(url: string, attempt: Attempt<A>): Effect.Effect<Routed<A>, FirecrawlError> => {
    const routed = (() => {
      switch (config.mode) {
        // Cloud runs are judged as before: only Firecrawl's own errors fail a page.
        case "cloud":
          return budgetedCloud(config.cloud, attempt, config.cloudProxy, reserveReached);
        case "local":
          return localOnly(config.local, attempt);
        case "hybrid":
          return hybrid(config, url, attempt);
      }
    })();
    return routed.pipe(Effect.tap((done) => logUsage(url, done)));
  };

  return firecrawlFrom({
    scrape: (url, request, kind) =>
      route(url, {
        kind,
        send: (backend, proxy) => backend.scrape(url, proxy ? { ...request, proxy } : request),
        page: (page) => page,
        cloudCredits,
        minCredits: 1,
      }).pipe(Effect.map(({ value, usage }) => ({ page: value, usage }))),
    // /map costs one credit per call.
    map: (url, options) =>
      route(url, {
        kind: "map",
        send: (backend) => backend.map(url, options),
        page: () => ({}),
        cloudCredits: () => 1,
        minCredits: 1,
      }).pipe(Effect.map(({ value, usage }) => ({ links: value.links, usage }))),
    search: (query, options) => {
      switch (config.mode) {
        case "cloud":
          return cloudSearch(config.cloud, query, options, reserveReached);
        case "local":
          return localSearch(config, query, options);
        case "hybrid":
          return cloudSearch(config.cloud, query, options, needsCloud).pipe(
            Effect.catchIf(
              (error) => error._tag === "FirecrawlBlocked" && error.status === 402,
              () => Effect.fail(new ScrapeFailed({ status: 402, message: needsCloudMessage })),
            ),
          );
      }
    },
  });
};

// A local scrape or map that takes longer than this is given up, so hybrid mode moves on to
// the cloud instead of waiting out the SDK's five-minute default.
export const localTimeoutMs = 60_000;

const cloudBackend = (apiKey: string) =>
  Effect.map(cloudLimiter, (limiter) => makeBackend("cloud", sdkClient({ apiKey }), limiter));

// A self-hosted instance without database authentication needs no key, and an empty one
// keeps the SDK from sending FIRECRAWL_API_KEY to it.
const localBackend = (apiUrl: string) =>
  Effect.map(localLimiter, (limiter) =>
    makeBackend("local", sdkClient({ apiKey: "", apiUrl, timeoutMs: localTimeoutMs }), limiter),
  );

// The plan a router's cloud instance, if it has one, budgets against.
export const planOf = (router: RouterConfig, creditReserve: number) =>
  FirecrawlPlan.of({
    mode: router.mode,
    creditReserve,
    creditUsage:
      router.mode === "local"
        ? Effect.succeed(null)
        : router.cloud.creditUsage.pipe(Effect.mapError(cloudError)),
  });

// The Firecrawl service and its plan, over the router's instances.
export const routerContext = (router: RouterConfig, creditReserve: number) =>
  Context.make(Firecrawl, makeScrapeRouter(router)).pipe(
    Context.add(FirecrawlPlan, planOf(router, creditReserve)),
  );

const routerConfig = (config: FirecrawlConfig) =>
  Effect.gen(function* () {
    switch (config.mode) {
      case "cloud":
        return {
          mode: "cloud",
          cloud: yield* cloudBackend(config.apiKey),
          cloudProxy: config.cloudProxy,
        } satisfies RouterConfig;
      case "local":
        return {
          mode: "local",
          local: yield* localBackend(config.localUrl),
          localSearch: config.localSearch,
        } satisfies RouterConfig;
      case "hybrid":
        return {
          mode: "hybrid",
          cloud: yield* cloudBackend(config.apiKey),
          local: yield* localBackend(config.localUrl),
          routes: yield* ScrapeRouteStore,
        } satisfies RouterConfig;
    }
  });

// Firecrawl routed per FIRECRAWL_MODE, with its plan and the local instance's health check.
export const firecrawlLayer = (config: FirecrawlConfig) =>
  Layer.mergeAll(
    Layer.effectContext(
      Effect.map(routerConfig(config), (router: RouterConfig) =>
        routerContext(router, config.mode === "local" ? 0 : config.creditReserve),
      ),
    ),
    Layer.succeed(
      ScrapeHealth,
      config.mode === "cloud"
        ? healthyScrapes
        : ScrapeHealth.of({ check: checkLocalFirecrawl(config.localUrl) }),
    ),
  );
