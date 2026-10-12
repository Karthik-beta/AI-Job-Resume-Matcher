import { describe, expect, test } from "bun:test";
import { fetchListings, fixture } from "../../../test/ats";
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
