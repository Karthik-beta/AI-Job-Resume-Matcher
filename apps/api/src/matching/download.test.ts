import { afterAll, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  type DownloadRequest,
  directDownloadUrl,
  HttpFetch,
  httpFetchLayer,
  makeHttpFetch,
} from "./download";

describe("directDownloadUrl", () => {
  test.each([
    [
      "https://drive.google.com/file/d/abc123/view?usp=sharing",
      "https://drive.google.com/uc?export=download&id=abc123",
    ],
    [
      "https://drive.google.com/open?id=abc123",
      "https://drive.google.com/uc?export=download&id=abc123",
    ],
    ["https://www.dropbox.com/s/xyz/cv.pdf?dl=0", "https://www.dropbox.com/s/xyz/cv.pdf?dl=1"],
    [
      "https://dropbox.com/scl/fi/xyz/cv.pdf?rlkey=k&dl=0",
      "https://dropbox.com/scl/fi/xyz/cv.pdf?rlkey=k&dl=1",
    ],
    ["https://www.dropbox.com/s/xyz/cv.pdf?dl=1", "https://www.dropbox.com/s/xyz/cv.pdf?dl=1"],
    ["https://drive.google.com/drive/folders/abc", "https://drive.google.com/drive/folders/abc"],
    ["https://example.com/cv.pdf", "https://example.com/cv.pdf"],
    ["not a url", "not a url"],
  ])("%s", (url, expected) => {
    expect(directDownloadUrl(url)).toBe(expected);
  });
});

describe("http fetch", () => {
  const server = Bun.serve({
    port: 0,
    fetch: (request) =>
      new Response(request.method === "HEAD" ? null : "%PDF-body", {
        status: request.headers.get("if-none-match") === '"v1"' ? 304 : 200,
        headers: { "content-type": "application/pdf" },
      }),
  });

  afterAll(() => server.stop(true));

  const request = (url: string, init?: DownloadRequest) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const http = yield* HttpFetch;
        return yield* http.request(url, init);
      }).pipe(Effect.provide(httpFetchLayer)),
    );

  test("downloads the body with its status and headers", async () => {
    const response = await request(server.url.href);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(new TextDecoder().decode(response.body)).toBe("%PDF-body");
  });

  test("sends the method and conditional headers", async () => {
    const head = await request(server.url.href, { method: "HEAD" });
    expect(head.body.length).toBe(0);
    const conditional = await request(server.url.href, { headers: { "If-None-Match": '"v1"' } });
    expect(conditional.status).toBe(304);
  });

  test("turns a network error into ScrapeFailed", async () => {
    const http = makeHttpFetch(() => Promise.reject(new Error("connection refused")));
    const error = await Effect.runPromise(Effect.flip(http.request("https://example.com/cv")));
    expect(error).toMatchObject({ _tag: "ScrapeFailed", message: "connection refused" });
    const odd = makeHttpFetch(() => Promise.reject("boom"));
    expect(await Effect.runPromise(Effect.flip(odd.request("https://example.com")))).toMatchObject({
      message: "boom",
    });
  });
});
