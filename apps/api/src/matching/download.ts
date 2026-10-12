import { Context, Effect, Layer } from "effect";
import { ScrapeFailed } from "./errors";

const getTimeoutMs = 30_000;
const headTimeoutMs = 10_000;
// A resume or job ad is far smaller; anything bigger is not worth holding in memory.
export const maxDownloadBytes = 20 * 1024 * 1024;

const tooLarge = () => new Error("The file is larger than 20 MB.");

export interface Download {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

export interface DownloadRequest {
  readonly method?: "GET" | "HEAD";
  readonly headers?: Record<string, string>;
}

export class HttpFetch extends Context.Service<
  HttpFetch,
  {
    readonly request: (
      url: string,
      request?: DownloadRequest,
    ) => Effect.Effect<Download, ScrapeFailed>;
  }
>()("HttpFetch") {}

export const makeHttpFetch = (fetch: (url: string, init: RequestInit) => Promise<Response>) =>
  HttpFetch.of({
    request: (url, { method = "GET", headers = {} } = {}) =>
      Effect.tryPromise({
        try: async (signal) => {
          const timeout = AbortSignal.timeout(method === "HEAD" ? headTimeoutMs : getTimeoutMs);
          const response = await fetch(url, {
            method,
            headers,
            redirect: "follow",
            signal: AbortSignal.any([signal, timeout]),
          });
          const length = Number(response.headers.get("content-length"));
          if (method === "GET" && length > maxDownloadBytes) {
            await response.body?.cancel();
            throw tooLarge();
          }
          const body = new Uint8Array(await response.arrayBuffer());
          if (body.byteLength > maxDownloadBytes) throw tooLarge();
          return { status: response.status, headers: response.headers, body };
        },
        catch: (cause) =>
          new ScrapeFailed({
            status: null,
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      }),
  });

export const httpFetchLayer = Layer.sync(HttpFetch, () => makeHttpFetch(globalThis.fetch));

export const isSuccess = (status: number) => status >= 200 && status < 300;

const driveFilePath = /^\/file\/d\/([^/]+)/;

// Share links open a viewer page; these forms download the file itself.
export const directDownloadUrl = (url: string) => {
  if (!URL.canParse(url)) return url;
  const parsed = new URL(url);
  if (parsed.hostname === "drive.google.com") {
    const id = driveFilePath.exec(parsed.pathname)?.[1] ?? parsed.searchParams.get("id");
    if (id) return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;
  }
  if (
    (parsed.hostname === "www.dropbox.com" || parsed.hostname === "dropbox.com") &&
    parsed.searchParams.get("dl") === "0"
  ) {
    parsed.searchParams.set("dl", "1");
    return parsed.toString();
  }
  return url;
};
