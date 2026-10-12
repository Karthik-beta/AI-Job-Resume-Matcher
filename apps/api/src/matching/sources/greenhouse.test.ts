import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { atsLayer, fakeHttp, fetchListings, fixture } from "../../../test/ats";
import type { Listing } from "../firecrawl";
import { greenhouseAdapter } from "./greenhouse";

const apiUrl = "https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true";
const source = {
  url: "https://job-boards.greenhouse.io/stripe",
  kind: "GREENHOUSE",
  adapterKey: "stripe",
} as const;

describe("Greenhouse adapter", () => {
  test("maps the board API's jobs to listings", async () => {
    const { result, requests } = await fetchListings(greenhouseAdapter, source, {
      [apiUrl]: await fixture("greenhouse.json"),
    });
    expect(requests).toEqual([apiUrl]);
    if (result._tag !== "Success") throw new Error(result.failure.message);
    expect(result.success).toHaveLength(2);
    const [first] = result.success;
    expect(first).toMatchObject({
      title: "Abuse Investigator",
      url: "https://stripe.com/jobs/search?gh_jid=8172510",
      company: "Stripe",
      locations: ["Seattle, San Francisco, New York City"],
      experienceMinYears: null,
      experienceMaxYears: null,
      remote: null,
      postedAt: "2026-09-09T14:50:29.000Z",
    });
    expect(first?.description).toStartWith("Who we are\n\nAbout Stripe\n\nStripe is a financial");
    expect(first?.description).not.toContain("&lt;");
    expect(first?.description).not.toContain("<");
  });

  test("reads remote work, a missing company and the update date", async () => {
    const job = {
      title: "Engineer",
      absolute_url: "https://example.com/jobs/1",
      location: { name: "Bengaluru" },
      metadata: [{ name: "Workplace", value: "Remote" }],
      content: "&lt;p&gt;3+ years of Go&lt;/p&gt;",
      updated_at: "2026-10-01T00:00:00Z",
    };
    const bare = { title: "Designer", absolute_url: "https://example.com/jobs/2" };
    const { result } = await fetchListings(
      greenhouseAdapter,
      { ...source, url: "https://job-boards.eu.greenhouse.io/acme", adapterKey: "acme" },
      {
        "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": JSON.stringify({
          jobs: [job, bare],
        }),
      },
    );
    if (result._tag !== "Success") throw new Error(result.failure.message);
    expect(result.success).toEqual([
      {
        title: "Engineer",
        url: "https://example.com/jobs/1",
        company: "acme",
        locations: ["Bengaluru"],
        experienceMinYears: 3,
        experienceMaxYears: null,
        remote: true,
        postedAt: "2026-10-01T00:00:00.000Z",
        description: "3+ years of Go",
      },
      {
        title: "Designer",
        url: "https://example.com/jobs/2",
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
    const { result } = await fetchListings(greenhouseAdapter, source, {
      [apiUrl]: { status: 404 },
    });
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ScrapeFailed",
        status: 404,
        message: "Greenhouse board 'stripe' not found.",
      },
    });
  });

  test("needs a board token", async () => {
    const { result, requests } = await fetchListings(
      greenhouseAdapter,
      { ...source, adapterKey: null },
      {},
    );
    expect(requests).toEqual([]);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        message: "Set the Greenhouse board name for https://job-boards.greenhouse.io/stripe.",
      },
    });
  });
});

describe("Greenhouse job ads", () => {
  const listing: Listing = {
    title: "Engineer",
    url: "https://job-boards.greenhouse.io/acme/jobs/123?gh_src=search",
    company: "acme",
    locations: [],
    experienceMinYears: null,
    experienceMaxYears: null,
    remote: null,
    postedAt: null,
  };
  const jobApi = "https://boards-api.greenhouse.io/v1/boards/acme/jobs/123?content=true";

  test("reads one job's ad from the board API", async () => {
    const job = {
      title: "Engineer",
      absolute_url: listing.url,
      content: "&lt;p&gt;Build payment APIs.&lt;/p&gt;",
    };
    const { http, requests } = fakeHttp({ [jobApi]: JSON.stringify(job) });
    const read = greenhouseAdapter.fetchDescription;
    if (!read) throw new Error("Expected fetchDescription");
    const text = await read(listing).pipe(Effect.provide(atsLayer(http)), Effect.runPromise);
    expect(text).toBe("Build payment APIs.");
    expect(requests).toEqual([jobApi]);
    const other = await read({ ...listing, url: "https://stripe.com/jobs?gh_jid=1" }).pipe(
      Effect.flip,
      Effect.provide(atsLayer(http)),
      Effect.runPromise,
    );
    expect(other.message).toBe("Not a Greenhouse job URL: https://stripe.com/jobs?gh_jid=1");
  });

  test("reads only job URLs on the board hosts", () => {
    const describes = greenhouseAdapter.describes ?? (() => true);
    expect(describes("https://boards.greenhouse.io/acme/jobs/9")).toBe(true);
    expect(describes("https://job-boards.eu.greenhouse.io/acme/jobs/9")).toBe(true);
    expect(describes("https://job-boards.greenhouse.io/acme")).toBe(false);
    expect(describes("https://stripe.com/jobs/search?gh_jid=8172510")).toBe(false);
    expect(describes("not a url")).toBe(false);
  });
});
