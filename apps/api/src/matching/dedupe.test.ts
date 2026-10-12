import { describe, expect, test } from "bun:test";
import { canonicalUrl, dedupeListings, normaliseText } from "./dedupe";
import type { Listing } from "./firecrawl";

describe("canonicalUrl", () => {
  test.each([
    ["https://Jobs.Example.COM/Engineer", "https://jobs.example.com/Engineer"],
    [
      "https://acme.com/jobs/1?utm_source=x&UTM_Medium=y&ref=feed&source=li&gh_src=abc&gh_jid=7",
      "https://acme.com/jobs/1?gh_jid=7",
    ],
    ["https://acme.com/jobs/1/?utm_campaign=z#apply", "https://acme.com/jobs/1"],
    ["https://acme.com/jobs/1//", "https://acme.com/jobs/1"],
    ["https://acme.com/", "https://acme.com/"],
    ["https://acme.com", "https://acme.com/"],
    ["https://acme.com/jobs?page=2&team=eng", "https://acme.com/jobs?page=2&team=eng"],
    ["not a url", "not a url"],
  ])("%s -> %s", (url, canonical) => {
    expect(canonicalUrl(url)).toBe(canonical);
  });
});

describe("normaliseText", () => {
  test("drops case, punctuation and extra whitespace", () => {
    expect(normaliseText("  Senior Engineer, Backend (Go)  ")).toBe("senior engineer backend go");
    expect(normaliseText("Senior  engineer – backend/go")).toBe("senior engineer backend go");
  });
});

describe("dedupeListings", () => {
  const listing = (fields: Partial<Listing>): Listing => ({
    title: "Engineer",
    url: "https://acme.com/jobs/1",
    company: "Acme",
    locations: [],
    experienceMinYears: null,
    experienceMaxYears: null,
    remote: null,
    postedAt: null,
    ...fields,
  });

  test("keeps the first listing of each canonical URL", () => {
    const first = listing({ url: "https://ACME.com/jobs/1/?utm_source=x", title: "First" });
    const kept = dedupeListings([
      first,
      listing({ url: "https://acme.com/jobs/1#top", title: "Second" }),
      listing({ url: "https://acme.com/jobs/2", title: "Other" }),
    ]);
    expect(kept).toEqual([
      { ...first, url: "https://acme.com/jobs/1" },
      listing({ url: "https://acme.com/jobs/2", title: "Other" }),
    ]);
  });

  test("keeps one listing per company, title and locations", () => {
    const kept = dedupeListings([
      listing({ title: "Backend Engineer", locations: ["Pune", "Remote"] }),
      listing({
        url: "https://jobs.lever.co/acme/1",
        title: "backend  engineer!",
        company: "ACME",
        locations: ["remote", "Pune "],
      }),
      listing({ url: "https://acme.com/jobs/3", title: "Backend Engineer", locations: ["Delhi"] }),
      listing({ url: "https://acme.com/jobs/4", title: "Backend Engineer", company: "Globex" }),
    ]);
    expect(kept.map(({ url }) => url)).toEqual([
      "https://acme.com/jobs/1",
      "https://acme.com/jobs/3",
      "https://acme.com/jobs/4",
    ]);
  });
});
