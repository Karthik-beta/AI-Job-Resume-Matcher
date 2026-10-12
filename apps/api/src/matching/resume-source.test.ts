import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { type Download, type DownloadRequest, HttpFetch } from "./download";
import { FirecrawlBlocked, ScrapeFailed } from "./errors";
import { Firecrawl } from "./firecrawl";
import { type CachedPage, PageCacheStore, type PageKey } from "./page-cache";
import { PdfParser } from "./pdf";
import { ResumeSource, resumeSourceLayer, sha256 } from "./resume-source";

const url = "https://example.com/cv.pdf";
const pdfV1 = new TextEncoder().encode("%PDF-1.7 version one");
const pdfV2 = new TextEncoder().encode("%PDF-1.7 version two");
const text1 = "Parsed %PDF-1.7 version one";
const text2 = "Parsed %PDF-1.7 version two";
const key: PageKey = { userId: "alice", url, kind: "RESUME" };
const hour = 60 * 60 * 1000;

const response = (
  status: number,
  body: Uint8Array = new Uint8Array(),
  headers: Record<string, string> = {},
): Download => ({
  status,
  body,
  headers: new Headers(headers),
});

const setup = (
  responses: (Download | ScrapeFailed)[],
  pages: (string | ScrapeFailed | FirecrawlBlocked)[] = [],
) => {
  const rows = new Map<string, CachedPage>();
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const parsed: string[] = [];
  const scraped: string[] = [];
  const id = ({ userId, url, kind }: PageKey) => `${userId} ${kind} ${url}`;
  const layer = resumeSourceLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          PageCacheStore,
          PageCacheStore.of({
            get: (key) => Effect.sync(() => rows.get(id(key)) ?? null),
            set: (key, content, expiresAt) =>
              Effect.sync(() => {
                rows.set(id(key), { content: JSON.parse(JSON.stringify(content)), expiresAt });
              }),
          }),
        ),
        Layer.succeed(
          HttpFetch,
          HttpFetch.of({
            request: (url, { headers = {} }: DownloadRequest = {}) =>
              Effect.suspend(() => {
                requests.push({ url, headers });
                const next = responses.shift() ?? response(500);
                return next instanceof ScrapeFailed ? Effect.fail(next) : Effect.succeed(next);
              }),
          }),
        ),
        Layer.succeed(
          PdfParser,
          PdfParser.of({
            parse: (bytes) =>
              Effect.sync(() => {
                const text = `Parsed ${new TextDecoder().decode(bytes)}`;
                parsed.push(text);
                return text;
              }),
          }),
        ),
        Layer.succeed(
          Firecrawl,
          Firecrawl.of({
            scrapeMarkdown: (url) =>
              Effect.suspend(() => {
                scraped.push(url);
                const next = pages.shift() ?? `# Resume page ${scraped.length}`;
                return typeof next === "string" ? Effect.succeed(next) : Effect.fail(next);
              }),
            scrapeListingPage: () => Effect.die("unused"),
          }),
        ),
      ),
    ),
  );
  const resolve = (resumeUrl = url) =>
    Effect.gen(function* () {
      const source = yield* ResumeSource;
      return yield* source.resolve("alice", resumeUrl);
    }).pipe(Effect.provide(layer), Effect.result, Effect.runPromise);
  // Moves a stored row's expiry into the past, as if a day had gone by.
  const age = (rowKey: PageKey) => {
    const row = rows.get(id(rowKey));
    if (row?.expiresAt) rows.set(id(rowKey), { ...row, expiresAt: new Date(Date.now() - hour) });
  };
  return { rows, requests, parsed, scraped, resolve, id, age };
};

describe("resume source", () => {
  test("parses a downloaded PDF and stores both hashes and its validators", async () => {
    const { resolve, rows, requests, id } = setup([
      response(200, pdfV1, { etag: '"v1"', "last-modified": "Mon, 05 Oct 2026 10:00:00 GMT" }),
    ]);
    expect(await resolve()).toMatchObject({ success: { text: text1, hash: sha256(text1) } });
    expect(requests).toEqual([{ url, headers: {} }]);
    expect(rows.get(id(key))).toEqual({
      content: {
        hash: sha256(text1),
        bytesHash: sha256(pdfV1),
        etag: '"v1"',
        lastModified: "Mon, 05 Oct 2026 10:00:00 GMT",
        markdown: text1,
      },
      expiresAt: null,
    });
  });

  test("reuses the cached text on a 304", async () => {
    const { resolve, requests, parsed } = setup([
      response(200, pdfV1, { etag: '"v1"', "last-modified": "Mon, 05 Oct 2026 10:00:00 GMT" }),
      response(304),
    ]);
    await resolve();
    expect(await resolve()).toMatchObject({ success: { text: text1, hash: sha256(text1) } });
    expect(requests[1]?.headers).toEqual({
      "If-None-Match": '"v1"',
      "If-Modified-Since": "Mon, 05 Oct 2026 10:00:00 GMT",
    });
    expect(parsed).toHaveLength(1);
  });

  test("reuses the cached text when the file has the same bytes", async () => {
    const { resolve, parsed, requests } = setup([response(200, pdfV1), response(200, pdfV1)]);
    await resolve();
    expect(await resolve()).toMatchObject({ success: { hash: sha256(text1) } });
    expect(requests).toHaveLength(2);
    expect(parsed).toHaveLength(1);
  });

  test("parses a new file at the same URL", async () => {
    const { resolve, parsed } = setup([response(200, pdfV1), response(200, pdfV2)]);
    await resolve();
    expect(await resolve()).toMatchObject({ success: { text: text2, hash: sha256(text2) } });
    expect(parsed).toHaveLength(2);
  });

  test("reuses a page's text for a day although its bytes change on every fetch", async () => {
    const page = "https://example.com/about-me";
    const pageKey: PageKey = { userId: "alice", url: page, kind: "RESUME" };
    const html = (nonce: string) => new TextEncoder().encode(`<html nonce="${nonce}">CV</html>`);
    const { resolve, scraped, parsed, requests, rows, id, age } = setup(
      [response(200, html("a")), response(200, html("b")), response(200, html("c"))],
      ["# My CV", "# My CV", "# My new CV"],
    );
    const first = { success: { text: "# My CV", hash: sha256("# My CV") } };
    expect(await resolve(page)).toMatchObject(first);
    const expiresIn = (rows.get(id(pageKey))?.expiresAt?.getTime() ?? 0) - Date.now();
    expect(expiresIn).toBeGreaterThan(23 * hour);
    expect(expiresIn).toBeLessThanOrEqual(24 * hour);

    // Within the day the page is neither downloaded nor scraped again.
    expect(await resolve(page)).toMatchObject(first);
    expect(requests).toHaveLength(1);
    expect(scraped).toEqual([page]);

    // After a day it is scraped again, and the same text keeps the same hash despite new bytes.
    age(pageKey);
    expect(await resolve(page)).toMatchObject(first);
    expect(scraped).toEqual([page, page]);

    age(pageKey);
    expect(await resolve(page)).toMatchObject({
      success: { text: "# My new CV", hash: sha256("# My new CV") },
    });
    expect(requests).toHaveLength(3);
    expect(parsed).toEqual([]);
  });

  test("falls back to Firecrawl when a page blocks the direct download", async () => {
    const page = "https://www.linkedin.com/in/alice";
    const pageKey: PageKey = { userId: "alice", url: page, kind: "RESUME" };
    const { resolve, scraped, rows, id } = setup(
      [response(403), new ScrapeFailed({ status: null, message: "connection reset" })],
      ["# Alice", "# Alice"],
    );
    expect(await resolve(page)).toMatchObject({
      success: { text: "# Alice", hash: sha256("# Alice") },
    });
    expect(rows.get(id(pageKey))?.content).toMatchObject({ bytesHash: null, markdown: "# Alice" });
    expect(rows.get(id(pageKey))?.expiresAt).not.toBeNull();
    rows.delete(id(pageKey));
    expect(await resolve(page)).toMatchObject({ success: { hash: sha256("# Alice") } });
    expect(scraped).toEqual([page, page]);
  });

  test("stops when both the download and Firecrawl fail", async () => {
    const page = "https://example.com/about-me";
    const { resolve, rows } = setup(
      [response(429), response(503)],
      [
        new ScrapeFailed({ status: 500, message: "Firecrawl returned 500." }),
        new FirecrawlBlocked({ status: 402, message: "Out of credits." }),
      ],
    );
    expect(await resolve(page)).toMatchObject({
      failure: {
        _tag: "ScrapeFailed",
        status: 429,
        message:
          "Could not download the resume: the server returned 429. Firecrawl also failed: Firecrawl returned 500.",
      },
    });
    expect(await resolve(page)).toMatchObject({
      failure: { _tag: "FirecrawlBlocked", status: 402 },
    });
    expect(rows.size).toBe(0);
  });

  test("downloads a Drive share link directly", async () => {
    const { resolve, requests } = setup([response(200, pdfV1)]);
    await resolve("https://drive.google.com/file/d/abc/view?usp=sharing");
    expect(requests[0]?.url).toBe("https://drive.google.com/uc?export=download&id=abc");
  });

  test("treats a markdown-only row from before hashing as a miss", async () => {
    const { resolve, rows, requests, parsed, id } = setup([response(200, pdfV1)]);
    rows.set(id(key), { content: "Old markdown", expiresAt: null });
    expect(await resolve()).toMatchObject({ success: { text: text1 } });
    expect(requests[0]?.headers).toEqual({});
    expect(parsed).toHaveLength(1);
  });

  test("treats a row without the bytes hash as a miss", async () => {
    const { resolve, rows, requests, parsed, id } = setup([response(200, pdfV1)]);
    const old = { hash: sha256(pdfV1), etag: '"v1"', lastModified: null, markdown: "Old" };
    rows.set(id(key), { content: old, expiresAt: null });
    expect(await resolve()).toMatchObject({ success: { text: text1, hash: sha256(text1) } });
    expect(requests[0]?.headers).toEqual({});
    expect(parsed).toHaveLength(1);
  });

  test("fails for a PDF URL when the download fails or returns an error status", async () => {
    const { resolve, rows, scraped } = setup([
      new ScrapeFailed({ status: null, message: "connection refused" }),
      response(404),
      response(304),
    ]);
    expect(await resolve()).toMatchObject({
      failure: {
        _tag: "ScrapeFailed",
        message: "Could not download the resume: connection refused",
      },
    });
    expect(await resolve()).toMatchObject({
      failure: { status: 404, message: "Could not download the resume: the server returned 404." },
    });
    // A 304 without a cached copy cannot be used.
    expect(await resolve()).toMatchObject({ failure: { status: 304 } });
    expect(rows.size).toBe(0);
    expect(scraped).toEqual([]);
  });
});
