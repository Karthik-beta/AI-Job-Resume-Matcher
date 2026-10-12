import { createHash } from "node:crypto";
import { Clock, Context, Duration, Effect, Layer, Option, Result, Schema } from "effect";
import { directDownloadUrl, HttpFetch, isSuccess } from "./download";
import { type FirecrawlBlocked, ScrapeFailed } from "./errors";
import { Firecrawl } from "./firecrawl";
import { PageCacheStore } from "./page-cache";
import { isPdf, PdfParser, pdfOrMarkdown } from "./pdf";

// Web pages carry nonces and tokens that change on every fetch, so their text is reused for a day
// instead of being scraped again whenever the bytes differ.
const pageTtl = Duration.hours(24);

export interface Resume {
  readonly text: string;
  // sha256 hex of the extracted text, so a resume whose content is unchanged keys runs the same.
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
  // sha256 of the downloaded bytes, so an unchanged file is never parsed or scraped again.
  // Null when the text came from Firecrawl after the direct download failed.
  bytesHash: Schema.NullOr(Schema.String),
  etag: Schema.NullOr(Schema.String),
  lastModified: Schema.NullOr(Schema.String),
  markdown: Schema.String,
});
type CachedResume = typeof CachedResume.Type;

// Rows from before both hashes were stored count as a miss.
const decodeCached = Schema.decodeUnknownOption(CachedResume);

export const sha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");

const downloadFailed = (status: number | null, reason: string) =>
  new ScrapeFailed({ status, message: `Could not download the resume: ${reason}` });

const looksLikePdf = (url: string) =>
  URL.canParse(url) && new URL(url).pathname.toLowerCase().endsWith(".pdf");

export const resumeSourceLayer = Layer.effect(
  ResumeSource,
  Effect.gen(function* () {
    const store = yield* PageCacheStore;
    const http = yield* HttpFetch;
    const firecrawl = yield* Firecrawl;
    const pdf = yield* PdfParser;

    const scrape = (url: string) =>
      firecrawl
        .scrapeMarkdown(url)
        .pipe(Effect.flatMap(pdfOrMarkdown), Effect.provideService(PdfParser, pdf));

    return ResumeSource.of({
      resolve: (userId, url) =>
        Effect.gen(function* () {
          const key = { userId, url, kind: "RESUME" } as const;
          const row = yield* store.get(key);
          const cached = Option.getOrNull(decodeCached(row?.content));
          const now = yield* Clock.currentTimeMillis;
          // Only page rows expire; a PDF row is checked with a conditional GET every run.
          if (cached && row?.expiresAt && row.expiresAt.getTime() > now) {
            return { text: cached.markdown, hash: cached.hash };
          }

          const save = (content: CachedResume, page: boolean) =>
            Effect.gen(function* () {
              const savedAt = yield* Clock.currentTimeMillis;
              const expiresAt = page ? new Date(savedAt + Duration.toMillis(pageTtl)) : null;
              yield* store.set(key, content, expiresAt);
              return { text: content.markdown, hash: content.hash };
            });

          // A page the server will not hand over directly (a login wall, a bot check) may still
          // render through Firecrawl, as the resume did before it was downloaded.
          const fallBack = (failure: ScrapeFailed) =>
            looksLikePdf(url)
              ? Effect.fail(failure)
              : scrape(url).pipe(
                  Effect.catchTag("ScrapeFailed", (error) =>
                    Effect.fail(
                      new ScrapeFailed({
                        status: failure.status,
                        message: `${failure.message} Firecrawl also failed: ${error.message}`,
                      }),
                    ),
                  ),
                  Effect.flatMap((text) =>
                    save(
                      {
                        hash: sha256(text),
                        bytesHash: null,
                        etag: null,
                        lastModified: null,
                        markdown: text,
                      },
                      true,
                    ),
                  ),
                );

          const headers: Record<string, string> = {};
          if (cached?.etag) headers["If-None-Match"] = cached.etag;
          if (cached?.lastModified) headers["If-Modified-Since"] = cached.lastModified;
          const download = yield* http.request(directDownloadUrl(url), { headers }).pipe(
            Effect.mapError((error) => downloadFailed(null, error.message)),
            Effect.result,
          );
          if (Result.isFailure(download)) return yield* fallBack(download.failure);
          const response = download.success;
          if (cached && response.status === 304) {
            return yield* save(cached, row?.expiresAt != null);
          }
          if (!isSuccess(response.status)) {
            return yield* fallBack(
              downloadFailed(response.status, `the server returned ${response.status}.`),
            );
          }

          const bytesHash = sha256(response.body);
          const isPdfBody = isPdf(response.body);
          const text =
            cached?.bytesHash === bytesHash
              ? cached.markdown
              : isPdfBody
                ? yield* pdf.parse(response.body)
                : // Not a PDF (a web page or a Google Doc), so Firecrawl renders it as before.
                  yield* scrape(url);
          return yield* save(
            {
              hash: sha256(text),
              bytesHash,
              etag: response.headers.get("etag"),
              lastModified: response.headers.get("last-modified"),
              markdown: text,
            },
            !isPdfBody,
          );
        }),
    });
  }),
);
