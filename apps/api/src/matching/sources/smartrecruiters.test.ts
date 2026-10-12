import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { atsLayer, fakeHttp, fetchListings, fixture } from "../../../test/ats";
import type { Listing } from "../firecrawl";
import { smartRecruitersAdapter } from "./smartrecruiters";

const api = "https://api.smartrecruiters.com/v1/companies/BoschGroup/postings";
const pageUrl = (offset: number) => `${api}?limit=100&offset=${offset}`;
const source = {
  url: "https://jobs.smartrecruiters.com/BoschGroup",
  kind: "SMARTRECRUITERS",
  adapterKey: "BoschGroup",
} as const;

const posting = (id: number) => ({ id: String(id), name: `Job ${id}` });

describe("SmartRecruiters adapter", () => {
  test("maps the postings list to listings without job ads", async () => {
    const { result, requests } = await fetchListings(smartRecruitersAdapter, source, {
      [pageUrl(0)]: await fixture("smartrecruiters-list.json"),
    });
    expect(requests).toEqual([pageUrl(0)]);
    if (result._tag !== "Success") throw new Error(result.failure.message);
    expect(result.success).toEqual([
      {
        title: "[Bosch HcP - Internship] Production Engineering Intern (Metal Forming & Washing)",
        url: "https://jobs.smartrecruiters.com/BoschGroup/744000154933569",
        company: "Bosch Group",
        locations: ["An Phuoc Commune, Dong Nai, Vietnam"],
        experienceMinYears: null,
        experienceMaxYears: null,
        remote: false,
        postedAt: "2026-10-12T06:59:25.204Z",
      },
      {
        title: "Solution Manager - Custom Web & Mobile Solutions, Bosch Digital India",
        url: "https://jobs.smartrecruiters.com/BoschGroup/744000154931829",
        company: "Bosch Group",
        locations: ["bengaluru, India"],
        experienceMinYears: null,
        experienceMaxYears: null,
        remote: false,
        postedAt: "2026-10-12T06:50:49.288Z",
      },
    ]);
  });

  test("pages through the list up to five pages", async () => {
    const pages = Object.fromEntries(
      [0, 100, 200, 300, 400, 500].map((offset) => [
        pageUrl(offset),
        JSON.stringify({
          totalFound: 1_000,
          content: Array.from({ length: 100 }, (_, i) => posting(offset + i)),
        }),
      ]),
    );
    const { result, requests } = await fetchListings(smartRecruitersAdapter, source, pages);
    expect(requests).toEqual([0, 100, 200, 300, 400].map(pageUrl));
    if (result._tag !== "Success") throw new Error(result.failure.message);
    expect(result.success).toHaveLength(500);
    expect(result.success[0]).toMatchObject({ company: "BoschGroup", locations: [], remote: null });
  });

  test("stops at an empty page", async () => {
    const { requests } = await fetchListings(smartRecruitersAdapter, source, {
      [pageUrl(0)]: JSON.stringify({ totalFound: 500, content: [posting(1)] }),
      [pageUrl(100)]: JSON.stringify({ totalFound: 500, content: [] }),
    });
    expect(requests).toEqual([pageUrl(0), pageUrl(100)]);
  });

  test("reads a selected job's ad from the posting API", async () => {
    const listing: Listing = {
      title: "Intern",
      url: "https://jobs.smartrecruiters.com/BoschGroup/744000154933569",
      company: "Bosch Group",
      locations: [],
      experienceMinYears: null,
      experienceMaxYears: null,
      remote: null,
      postedAt: null,
    };
    const { http, requests } = fakeHttp({
      [`${api}/744000154933569`]: await fixture("smartrecruiters-posting.json"),
    });
    const describe = smartRecruitersAdapter.fetchDescription;
    if (!describe) throw new Error("Expected fetchDescription");
    const text = await describe(listing).pipe(Effect.provide(atsLayer(http)), Effect.runPromise);
    expect(requests).toEqual([`${api}/744000154933569`]);
    expect(text).toStartWith(
      "Job Description\n- Being in charge of daily production monitoring and maintaining.",
    );
    expect(text).toContain("\n\nQualifications\n- 3rd or 4th-year students");
    expect(text).toContain("\n\nCompany Description\n- Bosch first started");
    expect(text).not.toContain("<");

    const other = await describe({ ...listing, url: "https://example.com/job" }).pipe(
      Effect.flip,
      Effect.provide(atsLayer(http)),
      Effect.runPromise,
    );
    expect(other.message).toBe("Not a SmartRecruiters job URL: https://example.com/job");
  });
});
