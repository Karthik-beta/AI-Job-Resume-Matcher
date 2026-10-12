import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { type Download, type DownloadRequest, HttpFetch } from "./download";
import { ScrapeFailed } from "./errors";
import { Firecrawl } from "./firecrawl";
import { type CachedPage, PageCacheStore, type PageKey } from "./page-cache";
import { PdfParser } from "./pdf";
import { ResumeSource, resumeSourceLayer, sha256 } from "./resume-source";

const url = "https://example.com/cv.pdf";
const pdfV1 = new TextEncoder().encode("%PDF-1.7 version one");
const pdfV2 = new TextEncoder().encode("%PDF-1.7 version two");
const key: PageKey = { userId: "alice", url, kind: "RESUME" };

const response = (
  status: number,
  body: Uint8Array = new Uint8Array(),
  headers: Record<string, string> = {},
): Download => ({
  status,
  body,
  headers: new Headers(headers),
});

const setup = (responses: (Download | ScrapeFailed)[]) => {
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
              Effect.sync(() => {
                scraped.push(url);
                return `# Resume page ${scraped.length}`;
              }),
            scrapeListings: () => Effect.succeed({ listings: [], rawHtml: null, links: [] }),
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
  return { rows, requests, parsed, scraped, resolve, id };
};

describe("resume source", () => {
  test("parses a downloaded PDF and stores its hash and validators", async () => {
    const { resolve, rows, requests, id } = setup([
      response(200, pdfV1, { etag: '"v1"', "last-modified": "Mon, 05 Oct 2026 10:00:00 GMT" }),
    ]);
    expect(await resolve()).toMatchObject({
      success: { text: "Parsed %PDF-1.7 version one", hash: sha256(pdfV1) },
    });
    expect(requests).toEqual([{ url, headers: {} }]);
    expect(rows.get(id(key))?.content).toEqual({
      hash: sha256(pdfV1),
      etag: '"v1"',
      lastModified: "Mon, 05 Oct 2026 10:00:00 GMT",
      markdown: "Parsed %PDF-1.7 version one",
    });
  });

  test("reuses the cached text on a 304", async () => {
    const { resolve, requests, parsed } = setup([
      response(200, pdfV1, { etag: '"v1"', "last-modified": "Mon, 05 Oct 2026 10:00:00 GMT" }),
      response(304),
    ]);
    await resolve();
    expect(await resolve()).toMatchObject({
      success: { text: "Parsed %PDF-1.7 version one", hash: sha256(pdfV1) },
    });
    expect(requests[1]?.headers).toEqual({
      "If-None-Match": '"v1"',
      "If-Modified-Since": "Mon, 05 Oct 2026 10:00:00 GMT",
    });
    expect(parsed).toHaveLength(1);
  });

  test("reuses the cached text when the file has the same hash", async () => {
    const { resolve, parsed } = setup([response(200, pdfV1), response(200, pdfV1)]);
    await resolve();
    expect(await resolve()).toMatchObject({ success: { hash: sha256(pdfV1) } });
    expect(parsed).toHaveLength(1);
  });

  test("parses a new file at the same URL", async () => {
    const { resolve, parsed } = setup([response(200, pdfV1), response(200, pdfV2)]);
    await resolve();
    expect(await resolve()).toMatchObject({
      success: { text: "Parsed %PDF-1.7 version two", hash: sha256(pdfV2) },
    });
    expect(parsed).toHaveLength(2);
  });

  test("scrapes a page that is not a PDF only when its bytes change", async () => {
    const page = "https://example.com/about-me";
    const v1 = new TextEncoder().encode("<html>v1</html>");
    const v2 = new TextEncoder().encode("<html>v2</html>");
    const { resolve, scraped, parsed } = setup([
      response(200, v1),
      response(200, v1),
      response(304),
      response(200, v2),
    ]);
    expect(await resolve(page)).toMatchObject({
      success: { text: "# Resume page 1", hash: sha256(v1) },
    });
    expect(await resolve(page)).toMatchObject({ success: { text: "# Resume page 1" } });
    expect(await resolve(page)).toMatchObject({ success: { text: "# Resume page 1" } });
    expect(scraped).toEqual([page]);
    expect(await resolve(page)).toMatchObject({
      success: { text: "# Resume page 2", hash: sha256(v2) },
    });
    expect(scraped).toEqual([page, page]);
    expect(parsed).toEqual([]);
  });

  test("downloads a Drive share link directly", async () => {
    const { resolve, requests } = setup([response(200, pdfV1)]);
    await resolve("https://drive.google.com/file/d/abc/view?usp=sharing");
    expect(requests[0]?.url).toBe("https://drive.google.com/uc?export=download&id=abc");
  });

  test("treats a markdown-only row from before hashing as a miss", async () => {
    const { resolve, rows, requests, parsed, id } = setup([response(200, pdfV1)]);
    rows.set(id(key), { content: "Old markdown", expiresAt: null });
    expect(await resolve()).toMatchObject({ success: { text: "Parsed %PDF-1.7 version one" } });
    expect(requests[0]?.headers).toEqual({});
    expect(parsed).toHaveLength(1);
  });

  test("fails when the download fails or returns an error status", async () => {
    const { resolve, rows } = setup([
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
  });
});
