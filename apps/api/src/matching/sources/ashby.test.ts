import { describe, expect, test } from "bun:test";
import { fetchListings, fixture } from "../../../test/ats";
import { ashbyAdapter } from "./ashby";

const apiUrl = "https://api.ashbyhq.com/posting-api/job-board/ashby?includeCompensation=true";
const source = {
  url: "https://jobs.ashbyhq.com/ashby",
  kind: "ASHBY",
  adapterKey: "ashby",
} as const;

describe("Ashby adapter", () => {
  test("maps the posting API's jobs to listings", async () => {
    const { result, requests } = await fetchListings(ashbyAdapter, source, {
      [apiUrl]: await fixture("ashby.json"),
    });
    expect(requests).toEqual([apiUrl]);
    if (result._tag !== "Success") throw new Error(result.failure.message);
    const [first, second] = result.success;
    expect(first).toMatchObject({
      title: "Engineering Manager - EU",
      url: "https://jobs.ashbyhq.com/ashby/7458d4e9-da2e-47bd-98cb-adfda43d42b2",
      company: "ashby",
      locations: ["Remote - European Union", "Spain", "Italy"],
      remote: true,
      postedAt: "2024-03-04T14:29:08.532Z",
    });
    expect(first?.description).toStartWith("Hi 👋 I’m Colin");
    expect(first?.description).toEndWith(
      "Compensation: €110K – €185K • Offers Equity • Offers Bonus",
    );
    expect(second?.locations).toEqual(["France", "United Kingdom", "Belgium"]);
  });

  test("skips unlisted jobs and reads missing fields", async () => {
    const jobs = [
      { title: "Hidden", jobUrl: "https://jobs.ashbyhq.com/acme/1", isListed: false },
      {
        title: "Engineer",
        jobUrl: "https://jobs.ashbyhq.com/acme/2",
        location: "Pune",
        secondaryLocations: [{ location: "Pune" }, {}],
        descriptionPlain: "2-4 years of TypeScript.",
      },
      { title: "Designer", jobUrl: "https://jobs.ashbyhq.com/acme/3" },
    ];
    const { result } = await fetchListings(
      ashbyAdapter,
      { ...source, adapterKey: "acme" },
      {
        "https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true":
          JSON.stringify({ jobs }),
      },
    );
    if (result._tag !== "Success") throw new Error(result.failure.message);
    expect(result.success).toEqual([
      {
        title: "Engineer",
        url: "https://jobs.ashbyhq.com/acme/2",
        company: "acme",
        locations: ["Pune"],
        experienceMinYears: 2,
        experienceMaxYears: 4,
        remote: null,
        postedAt: null,
        description: "2-4 years of TypeScript.",
      },
      {
        title: "Designer",
        url: "https://jobs.ashbyhq.com/acme/3",
        company: "acme",
        locations: [],
        experienceMinYears: null,
        experienceMaxYears: null,
        remote: null,
        postedAt: null,
      },
    ]);
  });

  test("names a missing board", async () => {
    const { result } = await fetchListings(ashbyAdapter, source, { [apiUrl]: { status: 404 } });
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { message: "Ashby board 'ashby' not found." },
    });
  });
});
