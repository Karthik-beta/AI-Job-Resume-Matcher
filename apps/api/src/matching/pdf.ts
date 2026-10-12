import { LiteParse } from "@llamaindex/liteparse";
import { Context, Effect, Layer } from "effect";
import { ScrapeFailed } from "./errors";

// Below this much text a PDF is likely scanned, so it is parsed again with OCR.
const minTextLength = 200;
// "%PDF" encoded as base64, which is how Firecrawl returns a PDF it did not parse.
const base64PdfPrefix = "JVBERi";

export class PdfParser extends Context.Service<
  PdfParser,
  { readonly parse: (bytes: Uint8Array) => Effect.Effect<string, ScrapeFailed> }
>()("PdfParser") {}

export type ExtractText = (bytes: Uint8Array, ocr: boolean) => Promise<string>;

const parseFailed = (cause: unknown) =>
  new ScrapeFailed({
    status: null,
    message: `Could not read the PDF: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

export const makePdfParser = (extract: ExtractText) =>
  PdfParser.of({
    parse: (bytes) =>
      Effect.gen(function* () {
        const text = yield* Effect.tryPromise({
          try: () => extract(bytes, false),
          catch: parseFailed,
        });
        if (text.trim().length >= minTextLength) return text;
        // OCR fetches its language data on first use, so a failure keeps the plain text.
        const ocrText = yield* Effect.tryPromise(() => extract(bytes, true)).pipe(
          Effect.orElseSucceed(() => ""),
        );
        const best = ocrText.trim().length > text.trim().length ? ocrText : text;
        if (best.trim()) return best;
        return yield* Effect.fail(parseFailed("the PDF has no text."));
      }),
  });

// Text output keeps two-column resumes readable; markdown output turns them into tables.
export const liteParseText: ExtractText = async (bytes, ocr) => {
  const parser = new LiteParse({ ocrEnabled: ocr, outputFormat: "text", quiet: true });
  return (await parser.parse(bytes)).text;
};

export const pdfParserLayer = Layer.succeed(PdfParser, makePdfParser(liteParseText));

export const isPdf = (bytes: Uint8Array) =>
  bytes.length >= 4 &&
  bytes[0] === 0x25 &&
  bytes[1] === 0x50 &&
  bytes[2] === 0x44 &&
  bytes[3] === 0x46;

// Firecrawl returns a PDF it was told not to parse as base64, which is parsed here instead.
export const pdfOrMarkdown = (markdown: string) =>
  Effect.gen(function* () {
    const trimmed = markdown.trim();
    if (!trimmed.startsWith(base64PdfPrefix)) return markdown;
    const parser = yield* PdfParser;
    return yield* parser.parse(new Uint8Array(Buffer.from(trimmed, "base64")));
  });
