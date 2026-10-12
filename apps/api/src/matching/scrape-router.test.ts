import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { ScrapeFailed } from "./errors";
import {
  Firecrawl,
  FirecrawlRequestFailed,
  type ScrapeBackend,
  type ScrapedPage,
  type ScrapeRequest,
  type Via,
} from "./firecrawl";
import {
  type CloudBudget,
  checkLocalFirecrawl,
  creditReserveFrom,
  FirecrawlPlan,
  firecrawlConfigFrom,
  firecrawlLayer,
  firecrawlModeFrom,
  localSearchMessage,
  makeScrapeRouter,
  needsCloudMessage,
  planOf,
  type RouterConfig,
  RunCloudBudget,
  ScrapeHealth,
  searchCost,
} from "./scrape-router";
import { memoryScrapeRouteStore, ScrapeRouteStore } from "./scrape-routes";

type Reply = ScrapedPage | FirecrawlRequestFailed;

const jobText = `# Backend Engineer\n\n${"Build payment APIs in TypeScript. ".repeat(20)}`;

const searchResults = Array.from({ length: 12 }, (_, index) => ({
  url: `https://jobs.lever.co/acme/${index}`,
  title: `Job ${index}`,
  description: null,
}));

const searchOptions = { includeDomains: ["jobs.lever.co"], tbs: "qdr:w", limit: 10 };

// A budget that allows the given number of requests and records what was spent.
const budgetOf = (requests: number) => {
  const spent: number[] = [];
  const budget: CloudBudget = {
    allows: () => Effect.succeed(spent.length < requests),
    spent: (credits) => Effect.sync(() => void spent.push(credits)),
    refusal: Effect.succeed("Firecrawl credit reserve reached (50 left until 2026-11-01)"),
  };
  return { budget, spent };
};

// Serves each URL's scripted reply, or a normal job page, and records the requests.
const fakeBackend = (via: Via, replies: Record<string, Reply> = {}) => {
  const calls: { url: string; request: ScrapeRequest | "map" | "search" }[] = [];
  const reply = (url: string) => {
    const scripted = replies[url];
    return scripted instanceof FirecrawlRequestFailed
      ? Effect.fail(scripted)
      : Effect.succeed(scripted ?? { markdown: jobText, metadata: { statusCode: 200 } });
  };
  const backend: ScrapeBackend = {
    via,
    scrape: (url, request) =>
      Effect.suspend(() => {
        calls.push({ url, request });
        return reply(url);
      }),
    // A search finds 12 results, or fails with the reply scripted for its query.
    search: (query) =>
      Effect.suspend(() => {
        calls.push({ url: query, request: "search" });
        const scripted = replies[query];
        return scripted instanceof FirecrawlRequestFailed
          ? Effect.fail(scripted)
          : Effect.succeed({ results: searchResults });
      }),
    map: (url) =>
      Effect.suspend(() => {
        calls.push({ url, request: "map" });
        return reply(url).pipe(Effect.as({ links: [{ url: `${url}/jobs/1` }] }));
      }),
    creditUsage:
      via === "cloud"
        ? Effect.succeed({ remainingCredits: 300, billingPeriodEnd: "2026-11-01T00:00:00Z" })
        : Effect.fail(failure(401, "Unauthorized")),
  };
  return { backend, calls };
};

const failure = (status: number | null, message = `Error ${status}`) =>
  new FirecrawlRequestFailed({ status, message });

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  effect
    .pipe(Effect.result, Effect.runPromise)
    .then((result) =>
      result._tag === "Success"
        ? { ok: true as const, value: result.success }
        : { ok: false as const, error: result.failure },
    );

const url = "https://acme.com/jobs/1";

const firecrawlScrape = (firecrawl: Firecrawl["Service"]) => firecrawl.scrapeJob(url);

describe("firecrawlConfigFrom", () => {
  test("defaults to the cloud with the basic proxy", () => {
    expect(firecrawlConfigFrom({ FIRECRAWL_API_KEY: "fc-key" })).toEqual({
      mode: "cloud",
      apiKey: "fc-key",
      cloudProxy: "basic",
      creditReserve: 50,
    });
  });

  test("reads each mode's settings", () => {
    expect(
      firecrawlConfigFrom({
        FIRECRAWL_MODE: "cloud",
        FIRECRAWL_API_KEY: "fc-key",
        FIRECRAWL_CLOUD_PROXY: "auto",
      }),
    ).toEqual({ mode: "cloud", apiKey: "fc-key", cloudProxy: "auto", creditReserve: 50 });
    expect(
      firecrawlConfigFrom({
        FIRECRAWL_MODE: "local",
        FIRECRAWL_LOCAL_URL: "http://localhost:3002/",
      }),
    ).toEqual({ mode: "local", localUrl: "http://localhost:3002", localSearch: false });
    expect(
      firecrawlConfigFrom({
        FIRECRAWL_MODE: "hybrid",
        FIRECRAWL_API_KEY: "fc-key",
        FIRECRAWL_LOCAL_URL: "http://localhost:3002",
        FIRECRAWL_CREDIT_RESERVE: "100",
      }),
    ).toEqual({
      mode: "hybrid",
      apiKey: "fc-key",
      localUrl: "http://localhost:3002",
      creditReserve: 100,
    });
  });

  test("reads whether the local instance can search", () => {
    const env = { FIRECRAWL_MODE: "local", FIRECRAWL_LOCAL_URL: "http://localhost:3002" };
    expect(firecrawlConfigFrom({ ...env, FIRECRAWL_LOCAL_SEARCH: "TRUE" })).toMatchObject({
      localSearch: true,
    });
    expect(firecrawlConfigFrom({ ...env, FIRECRAWL_LOCAL_SEARCH: "false" })).toMatchObject({
      localSearch: false,
    });
    expect(() => firecrawlConfigFrom({ ...env, FIRECRAWL_LOCAL_SEARCH: "yes" })).toThrow(
      'FIRECRAWL_LOCAL_SEARCH must be true or false, got "yes".',
    );
  });

  test("reads the credit reserve", () => {
    expect(creditReserveFrom({})).toBe(50);
    expect(creditReserveFrom({ FIRECRAWL_CREDIT_RESERVE: "0" })).toBe(0);
    expect(() => creditReserveFrom({ FIRECRAWL_CREDIT_RESERVE: "-5" })).toThrow(
      'FIRECRAWL_CREDIT_RESERVE must be a whole number of credits, got "-5".',
    );
    expect(() =>
      firecrawlConfigFrom({ FIRECRAWL_API_KEY: "fc-key", FIRECRAWL_CREDIT_RESERVE: "lots" }),
    ).toThrow("FIRECRAWL_CREDIT_RESERVE must be a whole number");
  });

  test.each<[Record<string, string>, string]>([
    [{}, "FIRECRAWL_MODE=cloud needs FIRECRAWL_API_KEY."],
    [{ FIRECRAWL_API_KEY: " " }, "FIRECRAWL_MODE=cloud needs FIRECRAWL_API_KEY."],
    [
      { FIRECRAWL_MODE: "local", FIRECRAWL_API_KEY: "fc-key" },
      "FIRECRAWL_MODE=local needs FIRECRAWL_LOCAL_URL (e.g. http://localhost:3002).",
    ],
    [
      { FIRECRAWL_MODE: "hybrid" },
      "FIRECRAWL_MODE=hybrid needs FIRECRAWL_API_KEY and FIRECRAWL_LOCAL_URL " +
        "(e.g. http://localhost:3002).",
    ],
    [
      { FIRECRAWL_MODE: "local", FIRECRAWL_LOCAL_URL: "localhost:3002" },
      'FIRECRAWL_LOCAL_URL must be an http(s) URL, got "localhost:3002".',
    ],
    [
      { FIRECRAWL_MODE: "remote", FIRECRAWL_API_KEY: "fc-key" },
      "FIRECRAWL_MODE must be cloud, local or hybrid, and FIRECRAWL_CLOUD_PROXY basic or auto.",
    ],
    [
      { FIRECRAWL_API_KEY: "fc-key", FIRECRAWL_CLOUD_PROXY: "stealth" },
      "FIRECRAWL_MODE must be cloud, local or hybrid, and FIRECRAWL_CLOUD_PROXY basic or auto.",
    ],
  ])("rejects %p", (env, message) => {
    expect(() => firecrawlConfigFrom(env)).toThrow(message);
  });

  test("reads the mode alone for the fake providers", () => {
    expect(firecrawlModeFrom({})).toBe("cloud");
    expect(firecrawlModeFrom({ FIRECRAWL_MODE: "hybrid" })).toBe("hybrid");
    expect(firecrawlModeFrom({ FIRECRAWL_MODE: "local" })).toBe("local");
    expect(firecrawlModeFrom({ FIRECRAWL_MODE: "nonsense" })).toBe("cloud");
  });
});

describe("cloud mode", () => {
  const router = (replies: Record<string, Reply> = {}) => {
    const cloud = fakeBackend("cloud", replies);
    const config: RouterConfig = { mode: "cloud", cloud: cloud.backend, cloudProxy: "auto" };
    return { firecrawl: makeScrapeRouter(config), cloud };
  };

  test("scrapes with the configured proxy and counts one credit", async () => {
    const { firecrawl, cloud } = router();
    const result = await run(firecrawl.scrapeJob(url));
    expect(result).toMatchObject({ ok: true, value: { usage: { via: "cloud", credits: 1 } } });
    expect(cloud.calls[0]?.request).toMatchObject({ proxy: "auto" });
  });

  test.each([401, 402, 429])("stops the run on %p", async (status) => {
    const { firecrawl } = router({ [url]: failure(status) });
    expect(await run(firecrawl.scrapeJob(url))).toMatchObject({
      ok: false,
      error: { _tag: "FirecrawlBlocked", status },
    });
  });

  test("fails just the page on other errors", async () => {
    const { firecrawl } = router({ [url]: failure(500), "https://down.com": failure(null) });
    expect(await run(firecrawl.scrapeJob(url))).toMatchObject({
      ok: false,
      error: { _tag: "ScrapeFailed", status: 500 },
    });
    expect(await run(firecrawl.scrapeMarkdown("https://down.com"))).toMatchObject({
      ok: false,
      error: { _tag: "ScrapeFailed", status: null },
    });
  });

  test("stops the run once the budget refuses a request, and counts what it spent", async () => {
    const { firecrawl, cloud } = router();
    const { budget, spent } = budgetOf(1);
    const scrape = firecrawlScrape(firecrawl).pipe(Effect.provideService(RunCloudBudget, budget));
    expect(await run(scrape)).toMatchObject({ ok: true });
    expect(await run(scrape)).toMatchObject({
      ok: false,
      error: {
        _tag: "FirecrawlBlocked",
        status: 402,
        message: "Firecrawl credit reserve reached (50 left until 2026-11-01)",
      },
    });
    expect(cloud.calls).toHaveLength(1);
    expect(spent).toEqual([1]);
  });

  test("searches for 2 credits per 10 results, within the budget", async () => {
    const { firecrawl, cloud } = router();
    const { budget, spent } = budgetOf(1);
    const search = firecrawl
      .search("engineer", searchOptions)
      .pipe(Effect.provideService(RunCloudBudget, budget));
    expect(await run(search)).toMatchObject({
      ok: true,
      value: { results: searchResults, usage: { via: "cloud", credits: 4 } },
    });
    expect(spent).toEqual([4]);
    expect(await run(search)).toMatchObject({
      ok: false,
      error: { _tag: "FirecrawlBlocked", status: 402 },
    });
    expect(cloud.calls).toEqual([{ url: "engineer", request: "search" }]);
    const blocked = router({ engineer: failure(429) });
    expect(await run(blocked.firecrawl.search("engineer", searchOptions))).toMatchObject({
      ok: false,
      error: { _tag: "FirecrawlBlocked", status: 429 },
    });
  });

  test("counts a search's credits per 10 results, and an empty one as the minimum", () => {
    expect([0, 1, 10, 11, 20].map(searchCost)).toEqual([2, 2, 2, 4, 4]);
  });

  test("maps a site for one credit", async () => {
    const { firecrawl } = router();
    expect(await run(firecrawl.map("https://acme.com", { search: "job", limit: 5 }))).toEqual({
      ok: true,
      value: { links: [{ url: "https://acme.com/jobs/1" }], usage: { via: "cloud", credits: 1 } },
    });
  });
});

const challenge: ScrapedPage = { markdown: "Just a moment...", metadata: { statusCode: 403 } };
const notFound: ScrapedPage = { markdown: "Page not found", metadata: { statusCode: 404 } };
const thinShell: ScrapedPage = { markdown: "Loading…", metadata: { statusCode: 200 } };

describe("local mode", () => {
  const router = (replies: Record<string, Reply> = {}) => {
    const local = fakeBackend("local", replies);
    return { firecrawl: makeScrapeRouter({ mode: "local", local: local.backend }), local };
  };

  test("scrapes without a proxy and uses no credits", async () => {
    const { firecrawl, local } = router();
    const result = await run(firecrawl.scrapeJob(url));
    expect(result).toMatchObject({ ok: true, value: { usage: { via: "local", credits: 0 } } });
    expect(local.calls[0]?.request).not.toHaveProperty("proxy");
  });

  test.each<[string, Reply, number | null, string]>([
    ["a challenge", challenge, 403, "The site blocked the local scraper (HTTP 403)."],
    [
      "a thin page",
      thinShell,
      200,
      "The site served the local scraper a bot check or a page without its content.",
    ],
    ["a missing page", notFound, 404, "The page is gone (HTTP 404)."],
    [
      "a bad request",
      { markdown: jobText, metadata: { statusCode: 400 } },
      400,
      "The page returned HTTP 400.",
    ],
    // Local has no credits or plan limit, so no status stops the run.
    ["a 401", failure(401, "Unauthorized"), 401, "Local Firecrawl: Unauthorized"],
    ["a 402", failure(402, "Payment required"), 402, "Local Firecrawl: Payment required"],
    ["a 429", failure(429, "Too many requests"), 429, "Local Firecrawl: Too many requests"],
    ["a timeout", failure(null, "timeout"), null, "Local Firecrawl: timeout"],
  ])("fails just the page on %s", async (_name, reply, status, message) => {
    const { firecrawl } = router({ [url]: reply });
    expect(await run(firecrawl.scrapeJob(url))).toEqual({
      ok: false,
      error: new ScrapeFailed({ status, message }),
    });
  });

  test("searches only through SearXNG on the local instance", async () => {
    const { firecrawl } = router();
    expect(await run(firecrawl.search("engineer", searchOptions))).toEqual({
      ok: false,
      error: new ScrapeFailed({ status: null, message: localSearchMessage }),
    });
    const local = fakeBackend("local", { broken: failure(500, "No search engine") });
    const searching = makeScrapeRouter({ mode: "local", local: local.backend, localSearch: true });
    expect(await run(searching.search("engineer", searchOptions))).toMatchObject({
      ok: true,
      value: { usage: { via: "local", credits: 0 } },
    });
    expect(await run(searching.search("broken", searchOptions))).toEqual({
      ok: false,
      error: new ScrapeFailed({ status: 500, message: "Local Firecrawl: No search engine" }),
    });
  });

  test("maps a site for no credits", async () => {
    const { firecrawl } = router();
    const result = await run(firecrawl.map("https://acme.com", { search: "job", limit: 5 }));
    expect(result).toMatchObject({ ok: true, value: { usage: { via: "local", credits: 0 } } });
    const failed = router({ "https://acme.com": failure(500) });
    expect(
      await run(failed.firecrawl.map("https://acme.com", { search: "job", limit: 5 })),
    ).toMatchObject({ ok: false, error: { _tag: "ScrapeFailed", status: 500 } });
  });
});

describe("hybrid mode", () => {
  const router = (local: Record<string, Reply> = {}, cloud: Record<string, Reply> = {}) => {
    const instances = { local: fakeBackend("local", local), cloud: fakeBackend("cloud", cloud) };
    const config: RouterConfig = {
      mode: "hybrid",
      local: instances.local.backend,
      cloud: instances.cloud.backend,
      routes: memoryScrapeRouteStore().store,
    };
    return { firecrawl: makeScrapeRouter(config), ...instances };
  };

  test("keeps a page the local instance scraped", async () => {
    const { firecrawl, cloud } = router();
    const result = await run(firecrawl.scrapeJob(url));
    expect(result).toMatchObject({ ok: true, value: { usage: { via: "local", credits: 0 } } });
    expect(cloud.calls).toEqual([]);
  });

  test.each<[string, Reply]>([
    ["a challenge", challenge],
    ["a thin job page", thinShell],
    ["a timeout", failure(null, "timeout")],
    ["an engine failure", failure(500, "All scraping engines failed")],
  ])("retries %s on the cloud with the auto proxy", async (_name, reply) => {
    const { firecrawl, cloud } = router({ [url]: reply });
    const result = await run(firecrawl.scrapeJob(url));
    expect(result).toMatchObject({ ok: true, value: { usage: { via: "cloud", credits: 1 } } });
    expect(cloud.calls).toEqual([{ url, request: expect.objectContaining({ proxy: "auto" }) }]);
  });

  test.each<[string, Reply, string]>([
    ["a missing page", notFound, "The page is gone (HTTP 404)."],
    ["a request error", failure(400, "Bad URL"), "Local Firecrawl: Bad URL"],
  ])("fails %s without trying the cloud", async (_name, reply, message) => {
    const { firecrawl, cloud } = router({ [url]: reply });
    expect(await run(firecrawl.scrapeJob(url))).toMatchObject({
      ok: false,
      error: { _tag: "ScrapeFailed", message },
    });
    expect(cloud.calls).toEqual([]);
  });

  test("fails just the page when the cloud is out of credits", async () => {
    const { firecrawl } = router({ [url]: challenge }, { [url]: failure(402) });
    expect(await run(firecrawl.scrapeJob(url))).toEqual({
      ok: false,
      error: new ScrapeFailed({ status: 402, message: needsCloudMessage }),
    });
  });

  test.each([401, 429])("stops the run on a cloud %p", async (status) => {
    const { firecrawl } = router({ [url]: challenge }, { [url]: failure(status) });
    expect(await run(firecrawl.scrapeJob(url))).toMatchObject({
      ok: false,
      error: { _tag: "FirecrawlBlocked", status },
    });
  });

  test("fails the page when the cloud is blocked too", async () => {
    const { firecrawl } = router({ [url]: challenge }, { [url]: challenge });
    expect(await run(firecrawl.scrapeJob(url))).toMatchObject({
      ok: false,
      error: { _tag: "ScrapeFailed", message: "The site blocked the cloud scraper (HTTP 403)." },
    });
  });

  test("asks the budget before the cloud and reports what was spent", async () => {
    const refused = router({ [url]: challenge });
    const none = budgetOf(0);
    expect(
      await run(
        refused.firecrawl.scrapeJob(url).pipe(Effect.provideService(RunCloudBudget, none.budget)),
      ),
    ).toEqual({ ok: false, error: new ScrapeFailed({ status: null, message: needsCloudMessage }) });
    expect(refused.cloud.calls).toEqual([]);
    const allowed = router({ [url]: challenge });
    const one = budgetOf(1);
    expect(
      await run(
        allowed.firecrawl.scrapeJob(url).pipe(Effect.provideService(RunCloudBudget, one.budget)),
      ),
    ).toMatchObject({ ok: true });
    expect(one.spent).toEqual([1]);
  });

  test("searches on the cloud, failing just the source when credits run out", async () => {
    const { firecrawl, local } = router();
    expect(await run(firecrawl.search("engineer", searchOptions))).toMatchObject({
      ok: true,
      value: { usage: { via: "cloud", credits: 4 } },
    });
    expect(local.calls).toEqual([]);
    const refused = firecrawl
      .search("engineer", searchOptions)
      .pipe(Effect.provideService(RunCloudBudget, budgetOf(0).budget));
    expect(await run(refused)).toEqual({
      ok: false,
      error: new ScrapeFailed({ status: null, message: needsCloudMessage }),
    });
    const empty = router({}, { engineer: failure(402) });
    expect(await run(empty.firecrawl.search("engineer", searchOptions))).toEqual({
      ok: false,
      error: new ScrapeFailed({ status: 402, message: needsCloudMessage }),
    });
  });

  test("maps on the cloud only when the local map is blocked", async () => {
    const blocked = router({ "https://acme.com": failure(null) });
    const result = await run(
      blocked.firecrawl.map("https://acme.com", { search: "job", limit: 5 }),
    );
    expect(result).toMatchObject({ ok: true, value: { usage: { via: "cloud", credits: 1 } } });
    const local = router();
    expect(
      await run(local.firecrawl.map("https://acme.com", { search: "job", limit: 5 })),
    ).toMatchObject({ ok: true, value: { usage: { via: "local", credits: 0 } } });
  });
});

describe("checkLocalFirecrawl", () => {
  const server = Bun.serve({
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/v0/health/readiness"
        ? Response.json({ status: "ok" })
        : new Response("Not found", { status: 404 }),
  });
  const down = Bun.serve({ port: 0, fetch: () => new Response("Starting", { status: 503 }) });
  const slow = Bun.serve({
    port: 0,
    fetch: () => Bun.sleep(500).then(() => Response.json({ status: "ok" })),
  });
  afterAll(() => Promise.all([server.stop(true), down.stop(true), slow.stop(true)]));

  test("passes when the instance is ready", async () => {
    expect(await run(checkLocalFirecrawl(server.url.origin))).toEqual({
      ok: true,
      value: undefined,
    });
  });

  test("fails when the instance is unhealthy, slow or not running", async () => {
    const stopped = Bun.serve({ port: 0, fetch: () => new Response() });
    const stoppedUrl = stopped.url.origin;
    await stopped.stop(true);
    for (const origin of [down.url.origin, stoppedUrl]) {
      expect(await run(checkLocalFirecrawl(origin))).toEqual({
        ok: false,
        error: expect.objectContaining({
          _tag: "LocalFirecrawlDown",
          message: `Local Firecrawl is not running at ${origin}`,
        }),
      });
    }
    expect(await run(checkLocalFirecrawl(slow.url.origin, 50))).toMatchObject({ ok: false });
  });
});

describe("firecrawlLayer", () => {
  const health = (layer: Layer.Layer<Firecrawl | ScrapeHealth, never, ScrapeRouteStore>) =>
    run(
      Effect.gen(function* () {
        yield* Firecrawl;
        return yield* (yield* ScrapeHealth).check;
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(ScrapeRouteStore, memoryScrapeRouteStore().store),
      ),
    );

  test("checks the local instance only when one is used", async () => {
    const cloud = firecrawlLayer({
      mode: "cloud",
      apiKey: "fc-key",
      cloudProxy: "basic",
      creditReserve: 50,
    });
    expect(await health(cloud)).toMatchObject({ ok: true });
    const localUrl = "http://127.0.0.1:9";
    const message = `Local Firecrawl is not running at ${localUrl}`;
    expect(
      await health(firecrawlLayer({ mode: "local", localUrl, localSearch: false })),
    ).toMatchObject({
      ok: false,
      error: { message },
    });
    expect(
      await health(
        firecrawlLayer({ mode: "hybrid", apiKey: "fc-key", localUrl, creditReserve: 0 }),
      ),
    ).toMatchObject({ ok: false, error: { message } });
  });

  test("provides the plan of the mode", async () => {
    const plan = await run(
      Effect.gen(function* () {
        return yield* FirecrawlPlan;
      }).pipe(
        Effect.provide(
          firecrawlLayer({ mode: "local", localUrl: "http://127.0.0.1:9", localSearch: false }),
        ),
        Effect.provideService(ScrapeRouteStore, memoryScrapeRouteStore().store),
      ),
    );
    expect(plan).toMatchObject({ ok: true, value: { mode: "local", creditReserve: 0 } });
  });
});

describe("planOf", () => {
  test("reads the cloud plan's credits, and none in local mode", async () => {
    const cloud = fakeBackend("cloud").backend;
    const cloudPlan = planOf({ mode: "cloud", cloud, cloudProxy: "basic" }, 50);
    expect(await run(cloudPlan.creditUsage)).toEqual({
      ok: true,
      value: { remainingCredits: 300, billingPeriodEnd: "2026-11-01T00:00:00Z" },
    });
    const local = planOf({ mode: "local", local: fakeBackend("local").backend }, 0);
    expect(await run(local.creditUsage)).toEqual({ ok: true, value: null });
    const unauthorized = planOf(
      { mode: "cloud", cloud: fakeBackend("local").backend, cloudProxy: "basic" },
      50,
    );
    expect(await run(unauthorized.creditUsage)).toMatchObject({
      ok: false,
      error: { _tag: "FirecrawlBlocked", status: 401 },
    });
  });
});
