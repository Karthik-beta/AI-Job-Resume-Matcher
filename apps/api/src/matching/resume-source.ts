import { createHash } from "node:crypto";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { directDownloadUrl, HttpFetch, isSuccess } from "./download";
import { type FirecrawlBlocked, ScrapeFailed } from "./errors";
import { Firecrawl } from "./firecrawl";
import { PageCacheStore } from "./page-cache";
import { isPdf, PdfParser, pdfOrMarkdown } from "./pdf";

export interface Resume {
  readonly text: string;
  // sha256 hex of the PDF bytes, or of the markdown for a page Firecrawl scraped.
  readonly hash: string;
}

export class ResumeSource extends Context.Service<
  ResumeSource,
  {
    readonly resolve: (
      userId: string,
      url: string,
    ) => Effect.Effect<Resume, ScrapeFailed | FirecrawlBlocked>;
  }
>()("ResumeSource") {}

const CachedResume = Schema.Struct({
  hash: Schema.String,
  etag: Schema.NullOr(Schema.String),
  lastModified: Schema.NullOr(Schema.String),
  markdown: Schema.String,
});

// Rows from before the hash was stored hold a bare string, which counts as a miss.
const decodeCached = Schema.decodeUnknownOption(CachedResume);

export const sha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");

const downloadFailed = (status: number | null, reason: string) =>
  new ScrapeFailed({ status, message: `Could not download the resume: ${reason}` });

export const resumeSourceLayer = Layer.effect(
  ResumeSource,
  Effect.gen(function* () {
    const store = yield* PageCacheStore;
    const http = yield* HttpFetch;
    const firecrawl = yield* Firecrawl;
    const pdf = yield* PdfParser;

    return ResumeSource.of({
      resolve: (userId, url) =>
        Effect.gen(function* () {
          const key = { userId, url, kind: "RESUME" } as const;
          const row = yield* store.get(key);
          const cached = Option.getOrNull(decodeCached(row?.content));
          const headers: Record<string, string> = {};
          if (cached?.etag) headers["If-None-Match"] = cached.etag;
          if (cached?.lastModified) headers["If-Modified-Since"] = cached.lastModified;

          const response = yield* http
            .request(directDownloadUrl(url), { headers })
            .pipe(Effect.mapError((error) => downloadFailed(null, error.message)));
          if (cached && response.status === 304) {
            return { text: cached.markdown, hash: cached.hash };
          }
          if (!isSuccess(response.status)) {
            return yield* Effect.fail(
              downloadFailed(response.status, `the server returned ${response.status}.`),
            );
          }

          let text: string;
          let hash: string;
          if (isPdf(response.body)) {
            hash = sha256(response.body);
            text = cached?.hash === hash ? cached.markdown : yield* pdf.parse(response.body);
          } else {
            // Not a PDF (a web page or a Google Doc), so Firecrawl renders it as before.
            text = yield* firecrawl
              .scrapeMarkdown(url)
              .pipe(Effect.flatMap(pdfOrMarkdown), Effect.provideService(PdfParser, pdf));
            hash = sha256(text);
          }
          yield* store.set(
            key,
            {
              hash,
              etag: response.headers.get("etag"),
              lastModified: response.headers.get("last-modified"),
              markdown: text,
            },
            null,
          );
          return { text, hash };
        }),
    });
  }),
);
