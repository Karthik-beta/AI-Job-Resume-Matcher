import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { isPdf, liteParseText, makePdfParser, PdfParser, pdfOrMarkdown } from "./pdf";

const fixture = new URL("../../test/fixtures/job-ad.pdf", import.meta.url);
const readFixture = async () => new Uint8Array(await Bun.file(fixture).arrayBuffer());
const longText = "Senior Backend Engineer ".repeat(10);

const scripted = (plain: string | Error, ocr: string | Error) => {
  const calls: boolean[] = [];
  const parser = makePdfParser(async (_bytes, useOcr) => {
    calls.push(useOcr);
    const result = useOcr ? ocr : plain;
    if (result instanceof Error) throw result;
    return result;
  });
  const parse = (bytes = new Uint8Array()) => Effect.runPromise(Effect.result(parser.parse(bytes)));
  return { calls, parse };
};

describe("pdf parser", () => {
  test("parses the fixture with LiteParse", async () => {
    const text = await Effect.runPromise(makePdfParser(liteParseText).parse(await readFixture()));
    expect(text).toContain("Senior Backend Engineer");
    expect(text).toContain("Acme Analytics");
  });

  test("skips OCR when the PDF has enough text", async () => {
    const { calls, parse } = scripted(longText, "ocr");
    expect(await parse()).toMatchObject({ _tag: "Success", success: longText });
    expect(calls).toEqual([false]);
  });

  test("uses OCR for a PDF with little text", async () => {
    const { calls, parse } = scripted("x", "Scanned resume text");
    expect(await parse()).toMatchObject({ success: "Scanned resume text" });
    expect(calls).toEqual([false, true]);
  });

  test("keeps the plain text when OCR fails or finds less", async () => {
    expect(await scripted("Short CV", new Error("offline")).parse()).toMatchObject({
      success: "Short CV",
    });
    expect(await scripted("Short CV", " ").parse()).toMatchObject({ success: "Short CV" });
  });

  test("fails when no text can be read", async () => {
    expect(await scripted(" ", new Error("offline")).parse()).toMatchObject({
      failure: { _tag: "ScrapeFailed", message: "Could not read the PDF: the PDF has no text." },
    });
    expect(await scripted(new Error("bad xref"), "").parse()).toMatchObject({
      failure: { message: "Could not read the PDF: bad xref" },
    });
  });

  test("detects PDF bytes", async () => {
    expect(isPdf(await readFixture())).toBe(true);
    expect(isPdf(new TextEncoder().encode("<html>"))).toBe(false);
    expect(isPdf(new Uint8Array())).toBe(false);
  });
});

describe("pdfOrMarkdown", () => {
  const run = (markdown: string) =>
    Effect.runPromise(
      pdfOrMarkdown(markdown).pipe(Effect.provideService(PdfParser, makePdfParser(liteParseText))),
    );

  test("parses a PDF Firecrawl returned as base64", async () => {
    const base64 = Buffer.from(await readFixture()).toString("base64");
    expect(base64.startsWith("JVBERi")).toBe(true);
    expect(await run(`${base64}\n`)).toContain("Acme Analytics");
  });

  test("keeps ordinary markdown", async () => {
    expect(await run("# Senior Engineer")).toBe("# Senior Engineer");
  });
});
