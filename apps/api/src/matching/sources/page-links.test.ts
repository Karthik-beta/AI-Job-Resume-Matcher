import { describe, expect, test } from "bun:test";
import { pageFixture } from "../../../test/pages";
import {
  anchorTitle,
  findJobLinks,
  isJobLink,
  isUsableTitle,
  markdownLinks,
  nextPageUrl,
  normaliseUrl,
  slugTitle,
} from "./page-links";

describe("findJobLinks", () => {
  test("reads a company careers page", async () => {
    const markdown = await pageFixture("acme-careers.md");
    expect(findJobLinks(markdown, "https://www.acme.com/careers")).toEqual([
      {
        url: "https://www.acme.com/careers/engineering/senior-backend-engineer",
        title: "Senior Backend Engineer",
      },
      {
        url: "https://www.acme.com/careers/engineering/frontend-engineer",
        title: "Frontend Engineer (React)",
      },
      { url: "https://careers.acme.com/jobs/product-designer", title: "Product Designer" },
    ]);
  });

  test("reads job links to ATS boards in a table", async () => {
    const markdown = await pageFixture("globex-board.md");
    expect(findJobLinks(markdown, "https://globex.io/careers")).toEqual([
      { url: "https://job-boards.greenhouse.io/globex/jobs/4012345", title: "Data Engineer" },
      {
        url: "https://job-boards.greenhouse.io/globex/jobs/4012346?gh_src=site",
        title: "Site Reliability Engineer",
      },
      {
        url: "https://jobs.lever.co/globex/0c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
        title: "Engineering Manager",
      },
    ]);
  });

  test("finds jobs without titles when every link reads 'Apply now'", async () => {
    const markdown = await pageFixture("initech-apply-only.md");
    expect(findJobLinks(markdown, "https://initech.com/jobs")).toEqual([
      { url: "https://initech.com/jobs/1042", title: null },
      { url: "https://initech.com/jobs/1043", title: null },
    ]);
  });

  test("finds nothing on a page that lists jobs as text", async () => {
    const markdown = await pageFixture("hooli-no-links.md");
    expect(findJobLinks(markdown, "https://hooli.com/about/careers")).toEqual([]);
  });
});

describe("isJobLink", () => {
  const page = "https://www.acme.com/careers";

  test.each([
    "/jobs/backend-engineer",
    "/job/42",
    "/careers/backend-engineer/",
    "/careers/engineering/backend-engineer",
    "/positions/backend",
    "/openings/backend",
    "/vacancies/backend",
    "/en/roles/48213",
    "/apply/0c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
    "https://careers.acme.com/jobs/1",
    "https://boards.greenhouse.io/acme/jobs/123",
  ])("accepts %p", (link) => {
    expect(isJobLink(link, page)).toBe(true);
  });

  test.each([
    "/careers",
    "/careers/",
    "/careers#open-roles",
    "/careers/backend-engineer",
    "/jobs",
    "/jobs?page=2",
    "/jobs/page/2",
    "/jobs/search",
    "/jobs/category/engineering",
    "/jobs/locations/pune",
    "/jobs/backend?department=engineering",
    "/jobs/backend?team=platform",
    "/roles/123",
    "https://www.linkedin.com/jobs/view/123456",
    "https://acme.com.evil.io/jobs/1",
    "mailto:jobs@acme.com",
    "javascript:void(0)",
    "http://[invalid",
  ])("rejects %p", (link) => {
    expect(isJobLink(link, page)).toBe(false);
  });

  test("matches sites under a two-level country domain", () => {
    expect(isJobLink("https://jobs.acme.co.uk/jobs/1", "https://www.acme.co.uk/careers")).toBe(
      true,
    );
    expect(isJobLink("https://other.co.uk/jobs/1", "https://www.acme.co.uk/careers")).toBe(false);
  });
});

describe("titles", () => {
  test.each([
    ["Senior Backend Engineer", true],
    ["QA", false],
    ["x".repeat(121), false],
    ["Apply now →", false],
    ["View job", false],
    ["Learn more", false],
    ["Read More", false],
    ["See all jobs", false],
    ["2024", false],
    ["Data Engineer, Payments", true],
  ])("%p is usable: %p", (title, usable) => {
    expect(isUsableTitle(title)).toBe(usable);
  });

  test.each([
    ["**Product Designer**\\\n  Pune", "Product Designer"],
    ["![logo](https://acme.com/logo.png) Data Engineer", "Data Engineer"],
    ["\n\n_Platform Engineer_\n\nRemote", "Platform Engineer"],
    ["C\\+\\+ Developer", "C++ Developer"],
    ["![](https://acme.com/logo.png)", ""],
  ])("reads the title of %p", (text, title) => {
    expect(anchorTitle(text)).toBe(title);
  });
});

describe("links", () => {
  test("reads markdown links with titles and angle brackets", () => {
    expect(markdownLinks('[A](/a "Title") [B](<https://b.com/b>) ![img](/i.png)')).toEqual([
      { text: "A", url: "/a" },
      { text: "B", url: "https://b.com/b" },
      { text: "img", url: "/i.png" },
    ]);
  });

  test.each([
    ["/jobs/1/", "https://acme.com/jobs/1"],
    ["https://ACME.com/jobs/1#apply", "https://acme.com/jobs/1"],
    ["?page=2", "https://acme.com/careers?page=2"],
    ["https://acme.com/", "https://acme.com/"],
    ["mailto:jobs@acme.com", null],
    ["http://[invalid", null],
  ])("normalises %p", (link, url) => {
    expect(normaliseUrl(link, "https://acme.com/careers")).toBe(url);
  });
});

describe("nextPageUrl", () => {
  const source = "https://acme.com/careers";

  test.each([
    ["[Next](/careers?page=2)", source, "https://acme.com/careers?page=2"],
    ["[Next page ›](/careers/all?start=10)", source, "https://acme.com/careers/all?start=10"],
    [
      "[»](https://acme.com/careers/page/3)",
      "https://acme.com/careers/page/2",
      "https://acme.com/careers/page/3",
    ],
    ["[1](/careers) [2](/careers?p=2) [3](/careers?p=3)", source, "https://acme.com/careers?p=2"],
    [
      "[1](/careers?p=1) [2](/careers?p=2) [3](/careers?p=3)",
      "https://acme.com/careers?p=2",
      "https://acme.com/careers?p=3",
    ],
    ["[More](/careers?offset=20)", source, "https://acme.com/careers?offset=20"],
    ["[2](/careers/page/2/)", source, "https://acme.com/careers/page/2"],
  ])("follows %p from %p", (markdown, page, next) => {
    expect(nextPageUrl(markdown, page, source)).toBe(next);
  });

  test.each([
    ["no links", "Jobs"],
    ["a previous page", "[Previous](/careers?page=1) [1](/careers?page=1)"],
    ["another path's pages", "[2](/blog?page=2)"],
    ["another host", "[Next](https://other.com/careers?page=2)"],
    ["the page itself", "[Next](/careers?page=2#top)"],
    ["a job link", "[Engineer](/careers/engineer/)"],
  ])("ignores %s", (_, markdown) => {
    expect(nextPageUrl(markdown, "https://acme.com/careers?page=2", source)).toBeNull();
  });
});

describe("slugTitle", () => {
  test.each([
    ["https://acme.com/jobs/senior-backend-engineer-123456", "Senior Backend Engineer"],
    ["https://acme.com/careers/data_engineer/", "Data Engineer"],
    ["https://acme.com/jobs/4012345", "Jobs"],
    ["https://acme.com/jobs/product-designer/4012345", "Product Designer"],
    ["https://acme.com/jobs/sre-0c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f", "Sre"],
    ["https://acme.com/jobs/qa%20lead.html", "Qa Lead"],
    ["https://acme.com/jobs/bad%E0%A4%A", "Bad%E0%A4%A"],
  ])("titles %p as %p", (url, title) => {
    expect(slugTitle(url)).toBe(title);
  });
});
