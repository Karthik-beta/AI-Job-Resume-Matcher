import { describe, expect, test } from "bun:test";
import { classifyScrape, type ScrapeOutcome } from "./classify-scrape";
import { FirecrawlRequestFailed, type ScrapedPage } from "./firecrawl";

const fixture = (name: string): Promise<ScrapedPage> =>
  Bun.file(new URL(`../../test/fixtures/scrapes/${name}.json`, import.meta.url)).json();

const failure = (status: number | null) =>
  ({ error: new FirecrawlRequestFailed({ status, message: `Error ${status}` }) }) as const;

describe("classifyScrape", () => {
  test.each<[string, ScrapeOutcome]>([
    ["cloudflare-challenge", "blocked"],
    ["forbidden", "blocked"],
    ["thin-shell", "blocked"],
    ["not-found", "gone"],
    ["job-page", "ok"],
  ])("judges the %s job page %p", async (name, outcome) => {
    expect(classifyScrape({ page: await fixture(name) }, "job")).toBe(outcome);
  });

  test("allows short pages other than job ads", async () => {
    expect(classifyScrape({ page: await fixture("thin-shell") }, "page")).toBe("ok");
    expect(classifyScrape({ page: await fixture("cloudflare-challenge") }, "page")).toBe("blocked");
  });

  test.each<[number, ScrapeOutcome]>([
    [401, "blocked"],
    [403, "blocked"],
    [407, "blocked"],
    [429, "blocked"],
    [503, "blocked"],
    [404, "gone"],
    [410, "gone"],
    [400, "failed"],
    [451, "failed"],
    [500, "failed"],
  ])("judges a page the site answered with %p as %p", async (statusCode, outcome) => {
    const page = { ...(await fixture("job-page")), metadata: { statusCode } };
    expect(classifyScrape({ page }, "job")).toBe(outcome);
  });

  test.each([
    "Attention Required! | Cloudflare",
    "Please verify you are human",
    "px-captcha",
    "Protected by DataDome",
    "Request unsuccessful. Incapsula incident ID",
  ])("spots the bot check %p", async (marker) => {
    const page = await fixture("job-page");
    expect(
      classifyScrape({ page: { ...page, markdown: `${marker}\n\n${page.markdown}` } }, "job"),
    ).toBe("blocked");
  });

  test("ignores a marker deep in a long page or in large HTML", async () => {
    const page = await fixture("job-page");
    const markdown = `${page.markdown}\n\n${"More about the team. ".repeat(100)}Solve the captcha.`;
    expect(classifyScrape({ page: { ...page, markdown } }, "job")).toBe("ok");
    const rawHtml = `<html>${"<p>Role</p>".repeat(3_000)}<div class="captcha"></div></html>`;
    expect(classifyScrape({ page: { ...page, rawHtml } }, "job")).toBe("ok");
  });

  test("keeps a full job page that loads reCAPTCHA or a bot-protection script", async () => {
    const page = await fixture("job-page");
    const markdown = `${page.markdown}\n\n${"We hire across Europe and the US. ".repeat(40)}`;
    const rawHtml =
      '<html><head><script src="https://www.google.com/recaptcha/api.js"></script>' +
      '<script src="https://js.datadome.co/tags.js"></script></head><body>' +
      '<form><div class="g-recaptcha"></div><p>This form is protected by reCAPTCHA.</p></form>' +
      "</body></html>";
    expect(classifyScrape({ page: { ...page, markdown, rawHtml } }, "job")).toBe("ok");
    const intro = "Apply below. This site is protected by reCAPTCHA and hCaptcha.";
    expect(classifyScrape({ page: { ...page, markdown: `${intro}\n\n${markdown}` } }, "job")).toBe(
      "ok",
    );
  });

  test("counts a vendor captcha on a short page or under a challenge title", async () => {
    const page = await fixture("job-page");
    const rawHtml = '<html><body><div class="g-recaptcha"></div></body></html>';
    // The fixture's ad is shorter than a real one, so it reads as a challenge page.
    expect(classifyScrape({ page: { ...page, rawHtml } }, "job")).toBe("blocked");
    const markdown = `${page.markdown}\n\n${"We hire across Europe and the US. ".repeat(40)}`;
    const titled = { ...page, markdown, rawHtml, metadata: { title: "Security check" } };
    expect(classifyScrape({ page: titled }, "job")).toBe("blocked");
  });

  test.each<[number | null, ScrapeOutcome]>([
    // The instance gave no answer about the page, so the site is not to blame.
    [null, "unreachable"],
    [408, "unreachable"],
    [500, "unreachable"],
    [503, "unreachable"],
    [401, "unreachable"],
    [403, "unreachable"],
    [429, "unreachable"],
    [404, "gone"],
    [400, "failed"],
    // Firecrawl reports some failures, such as a DNS error, with a 200.
    [200, "failed"],
  ])("judges a request that failed with %p as %p", (status, outcome) => {
    expect(classifyScrape(failure(status), "job")).toBe(outcome);
    expect(classifyScrape(failure(status), "map")).toBe(outcome);
  });

  test("accepts any map that came back", () => {
    expect(classifyScrape({ page: {} }, "map")).toBe("ok");
  });
});
