import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import {
  Firecrawl,
  FirecrawlRequestFailed,
  type ScrapeBackend,
  type ScrapedPage,
  type ScrapeRequest,
  type Via,
} from "./firecrawl";
import {
  checkLocalFirecrawl,
  firecrawlConfigFrom,
  firecrawlLayer,
  firecrawlModeFrom,
  makeScrapeRouter,
  type RouterConfig,
  ScrapeHealth,
} from "./scrape-router";

type Reply = ScrapedPage | FirecrawlRequestFailed;

const jobText = `# Backend Engineer\n\n${"Build payment APIs in TypeScript. ".repeat(20)}`;

// Serves each URL's scripted reply, or a normal job page, and records the requests.
const fakeBackend = (via: Via, replies: Record<string, Reply> = {}) => {
  const calls: { url: string; request: ScrapeRequest | "map" }[] = [];
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
    map: (url) =>
      Effect.suspend(() => {
        calls.push({ url, request: "map" });
        return reply(url).pipe(Effect.as({ links: [{ url: `${url}/jobs/1` }] }));
      }),
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

describe("firecrawlConfigFrom", () => {
  test("defaults to the cloud with the basic proxy", () => {
    expect(firecrawlConfigFrom({ FIRECRAWL_API_KEY: "fc-key" })).toEqual({
      mode: "cloud",
      apiKey: "fc-key",
      cloudProxy: "basic",
    });
  });

  test("reads each mode's settings", () => {
    expect(
      firecrawlConfigFrom({
        FIRECRAWL_MODE: "cloud",
        FIRECRAWL_API_KEY: "fc-key",
        FIRECRAWL_CLOUD_PROXY: "auto",
      }),
    ).toEqual({ mode: "cloud", apiKey: "fc-key", cloudProxy: "auto" });
    expect(
      firecrawlConfigFrom({
        FIRECRAWL_MODE: "local",
        FIRECRAWL_LOCAL_URL: "http://localhost:3002/",
      }),
    ).toEqual({ mode: "local", localUrl: "http://localhost:3002" });
    expect(
      firecrawlConfigFrom({
        FIRECRAWL_MODE: "hybrid",
        FIRECRAWL_API_KEY: "fc-key",
        FIRECRAWL_LOCAL_URL: "http://localhost:3002",
      }),
    ).toEqual({ mode: "hybrid", apiKey: "fc-key", localUrl: "http://localhost:3002" });
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

  test("maps a site for one credit", async () => {
    const { firecrawl } = router();
    expect(await run(firecrawl.map("https://acme.com", { search: "job", limit: 5 }))).toEqual({
      ok: true,
      value: { links: [{ url: "https://acme.com/jobs/1" }], usage: { via: "cloud", credits: 1 } },
    });
  });
});

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

  // Local has no credits or plan limit, so no status stops the run.
  test.each([401, 402, 429, null])("fails just the page on %p", async (status) => {
    const { firecrawl } = router({ [url]: failure(status, "Request failed") });
    expect(await run(firecrawl.scrapeJob(url))).toMatchObject({
      ok: false,
      error: { _tag: "ScrapeFailed", status, message: "Local Firecrawl: Request failed" },
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
    };
    return { firecrawl: makeScrapeRouter(config), ...instances };
  };

  test("keeps a page the local instance scraped", async () => {
    const { firecrawl, cloud } = router();
    const result = await run(firecrawl.scrapeJob(url));
    expect(result).toMatchObject({ ok: true, value: { usage: { via: "local", credits: 0 } } });
    expect(cloud.calls).toEqual([]);
  });

  test("retries a failed local scrape on the cloud with the auto proxy", async () => {
    const { firecrawl, cloud } = router({ [url]: failure(null, "timeout") });
    const result = await run(firecrawl.scrapeJob(url));
    expect(result).toMatchObject({ ok: true, value: { usage: { via: "cloud", credits: 1 } } });
    expect(cloud.calls[0]?.request).toMatchObject({ proxy: "auto" });
  });

  test("maps on the cloud when the local map fails", async () => {
    const { firecrawl } = router({ "https://acme.com": failure(null) });
    const result = await run(firecrawl.map("https://acme.com", { search: "job", limit: 5 }));
    expect(result).toMatchObject({ ok: true, value: { usage: { via: "cloud", credits: 1 } } });
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
  const health = (layer: Layer.Layer<Firecrawl | ScrapeHealth>) =>
    run(
      Effect.gen(function* () {
        yield* Firecrawl;
        return yield* (yield* ScrapeHealth).check;
      }).pipe(Effect.provide(layer)),
    );

  test("checks the local instance only when one is used", async () => {
    const cloud = firecrawlLayer({ mode: "cloud", apiKey: "fc-key", cloudProxy: "basic" });
    expect(await health(cloud)).toMatchObject({ ok: true });
    const localUrl = "http://127.0.0.1:9";
    const message = `Local Firecrawl is not running at ${localUrl}`;
    expect(await health(firecrawlLayer({ mode: "local", localUrl }))).toMatchObject({
      ok: false,
      error: { message },
    });
    expect(
      await health(firecrawlLayer({ mode: "hybrid", apiKey: "fc-key", localUrl })),
    ).toMatchObject({ ok: false, error: { message } });
  });
});
