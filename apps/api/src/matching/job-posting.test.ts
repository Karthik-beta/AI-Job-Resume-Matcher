import { describe, expect, test } from "bun:test";
import { pageFixture } from "../../test/pages";
import type { Listing } from "./firecrawl";
import {
  evaluationText,
  isExpired,
  type JobPosting,
  maxJobPageChars,
  parseJobPosting,
  withPosting,
} from "./job-posting";

const script = (json: unknown) =>
  `<script type="application/ld+json">${typeof json === "string" ? json : JSON.stringify(json)}</script>`;

const posting = (fields: Partial<JobPosting> = {}): JobPosting => ({
  description: null,
  validThrough: null,
  locations: [],
  remote: null,
  experienceMinYears: null,
  experienceMaxYears: null,
  ...fields,
});

const listing: Listing = {
  title: "Engineer",
  url: "https://acme.com/jobs/1",
  company: "Acme",
  locations: [],
  experienceMinYears: null,
  experienceMaxYears: null,
  remote: null,
  postedAt: null,
};

describe("parseJobPosting", () => {
  test("reads an Ashby job page", async () => {
    expect(parseJobPosting(await pageFixture("ashby-job.html"))).toEqual({
      description:
        "Hi 👋 I’m Colin, Director of Engineering, Europe.\n- Provide feedback on product and " +
        "technical specs.\n- Grow engineers.\n\nWhy be a manager?",
      validThrough: null,
      locations: ["European Union", "Spain", "Germany"],
      remote: true,
      experienceMinYears: null,
      experienceMaxYears: null,
    });
  });

  test("reads a Lever job page", async () => {
    expect(parseJobPosting(await pageFixture("lever-job.html"))).toEqual({
      description:
        "This is a test job - created by Alex Haugan, for testing candidate insights.\n\n" +
        "Join a scaling, tight-knit team.",
      validThrough: null,
      locations: ["Atlanta, Georgia"],
      remote: null,
      experienceMinYears: null,
      experienceMaxYears: null,
    });
  });

  test("finds a posting in an @graph after an invalid block", () => {
    const html =
      script("{ not json") +
      script({
        "@context": "https://schema.org",
        "@graph": [
          { "@type": "Organization", name: "Acme" },
          {
            "@type": ["Thing", "JobPosting"],
            validThrough: "2026-10-01",
            jobLocation: [
              { "@type": "Place", address: { addressLocality: "Pune", addressCountry: "IN" } },
              { "@type": "Place", address: "Remote, India" },
            ],
            jobLocationType: ["TELECOMMUTE"],
            experienceRequirements: {
              "@type": "OccupationalExperienceRequirements",
              monthsOfExperience: 30,
            },
          },
        ],
      });
    expect(parseJobPosting(html)).toEqual(
      posting({
        validThrough: "2026-10-01T23:59:59.999Z",
        locations: ["Pune, IN", "Remote, India"],
        remote: true,
        experienceMinYears: 2.5,
      }),
    );
  });

  test("reads a validThrough time without an offset as UTC", () => {
    const html = script({ "@type": "JobPosting", validThrough: "2026-09-30T12:00:00" });
    expect(parseJobPosting(html)?.validThrough).toBe("2026-09-30T12:00:00.000Z");
    const offset = script({ "@type": "JobPosting", validThrough: "2026-09-30T12:00:00+05:30" });
    expect(parseJobPosting(offset)?.validThrough).toBe("2026-09-30T06:30:00.000Z");
  });

  test("reads a posting from an array and its experience text", () => {
    const html = script([
      { "@type": "WebPage" },
      {
        "@type": "schema:JobPosting",
        validThrough: "2026-09-30T12:00:00Z",
        description: "&lt;p&gt;Build APIs&lt;/p&gt;",
        applicantLocationRequirements: { "@type": "State", name: "Karnataka" },
        experienceRequirements: "3-5 years of backend work",
      },
    ]);
    expect(parseJobPosting(html)).toEqual(
      posting({
        description: "Build APIs",
        validThrough: "2026-09-30T12:00:00.000Z",
        locations: ["Karnataka"],
        experienceMinYears: 3,
        experienceMaxYears: 5,
      }),
    );
  });

  test("reads experience described in a requirement object", () => {
    const html = script({
      "@type": "JobPosting",
      experienceRequirements: [{ description: "Experience with Go" }, { name: "4+ years" }],
      jobLocation: { "@type": "Place", name: "Head office" },
    });
    expect(parseJobPosting(html)).toMatchObject({
      locations: ["Head office"],
      experienceMinYears: 4,
    });
  });

  test.each([
    ["no structured data", "<html><body>Job</body></html>"],
    ["only invalid JSON", script("{")],
    ["no JobPosting", script({ "@type": "Organization", name: "Acme" })],
  ])("returns null for %s", (_name, html) => {
    expect(parseJobPosting(html)).toBeNull();
  });
});

describe("isExpired", () => {
  const now = Date.parse("2026-10-12T00:00:00Z");

  test.each([
    [posting({ validThrough: "2026-10-11T23:59:59.999Z" }), true],
    [posting({ validThrough: "2026-10-12T00:00:01.000Z" }), false],
    [posting(), false],
    [null, false],
  ])("%p is expired: %p", (value, expired) => {
    expect(isExpired(value, now)).toBe(expired);
  });
});

describe("withPosting", () => {
  test("fills in missing locations, remote status and experience", () => {
    const facts = posting({
      locations: ["Pune"],
      remote: true,
      experienceMinYears: 2,
      experienceMaxYears: 4,
    });
    expect(withPosting(listing, facts)).toEqual({
      ...listing,
      locations: ["Pune"],
      remote: true,
      experienceMinYears: 2,
      experienceMaxYears: 4,
    });
  });

  test("keeps what the listing already knows", () => {
    const known = { ...listing, locations: ["Mumbai"], remote: false, experienceMaxYears: 3 };
    const facts = posting({ locations: ["Pune"], remote: true, experienceMinYears: 5 });
    expect(withPosting(known, facts)).toEqual(known);
    expect(withPosting(known, null)).toBe(known);
  });
});

describe("evaluationText", () => {
  test("sends the posting's own ad instead of the page", () => {
    const page = { markdown: "Whole page", posting: posting({ description: "The ad." }) };
    expect(evaluationText({ ...listing, locations: ["Pune"] }, page)).toBe(
      "# Engineer\n\nAcme · Pune\n\nThe ad.",
    );
  });

  test("cuts a page without structured data", () => {
    const markdown = "x".repeat(maxJobPageChars + 10);
    expect(evaluationText(listing, { markdown, posting: posting() })).toHaveLength(maxJobPageChars);
    expect(evaluationText(listing, { markdown: "Short", posting: null })).toBe("Short");
  });
});
