import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { atsLayer, fakeHttp, fetchListings, fixture } from "../../../test/ats";
import type { Listing } from "../firecrawl";
import { leverAdapter } from "./lever";

const apiUrl = "https://api.lever.co/v0/postings/leverdemo?mode=json";
const source = {
  url: "https://jobs.lever.co/leverdemo",
  kind: "LEVER",
  adapterKey: "leverdemo",
} as const;

describe("Lever adapter", () => {
  test("maps the postings API to listings", async () => {
    const { result, requests } = await fetchListings(leverAdapter, source, {
      [apiUrl]: await fixture("lever.json"),
    });
    expect(requests).toEqual([apiUrl]);
    if (result._tag !== "Success") throw new Error(result.failure.message);
    const [first, second] = result.success;
    expect(first).toMatchObject({
      title: "Customer Success Manager",
      url: "https://jobs.lever.co/leverdemo/ad208490-4052-4f91-a57e-433f2d1e484b",
      company: "leverdemo",
      locations: ["Atlanta, Georgia"],
      experienceMinYears: 3,
      experienceMaxYears: null,
      remote: false,
      postedAt: "2026-08-31T18:12:19.703Z",
    });
    expect(first?.description).toStartWith("This is a test job");
    expect(first?.description).toContain("Skill Set:\n- 3+ years of customer relationship");
    expect(second).toMatchObject({ title: "Dentist", remote: false, locations: ["Houston, TX"] });
  });

  test("uses the EU API and reads remote and missing fields", async () => {
    const postings = [
      {
        text: "Engineer",
        hostedUrl: "https://jobs.eu.lever.co/acme/1",
        categories: { location: "Berlin" },
        workplaceType: "remote",
        additionalPlain: "Two to three years is fine.",
      },
      {
        text: "Designer",
        hostedUrl: "https://jobs.eu.lever.co/acme/2",
        workplaceType: "unspecified",
      },
    ];
    const { result } = await fetchListings(
      leverAdapter,
      { ...source, url: "https://jobs.eu.lever.co/acme", adapterKey: "acme" },
      { "https://api.eu.lever.co/v0/postings/acme?mode=json": JSON.stringify(postings) },
    );
    if (result._tag !== "Success") throw new Error(result.failure.message);
    expect(result.success).toEqual([
      {
        title: "Engineer",
        url: "https://jobs.eu.lever.co/acme/1",
        company: "acme",
        locations: ["Berlin"],
        experienceMinYears: null,
        experienceMaxYears: null,
        remote: true,
        postedAt: null,
        description: "Two to three years is fine.",
      },
      {
        title: "Designer",
        url: "https://jobs.eu.lever.co/acme/2",
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
    const { result } = await fetchListings(leverAdapter, source, { [apiUrl]: { status: 404 } });
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { message: "Lever board 'leverdemo' not found." },
    });
  });
});

describe("Lever job ads", () => {
  const id = "ad208490-4052-4f91-a57e-433f2d1e484b";
  const listing: Listing = {
    title: "Engineer",
    url: `https://jobs.eu.lever.co/acme/${id}/apply`,
    company: "acme",
    locations: [],
    experienceMinYears: null,
    experienceMaxYears: null,
    remote: null,
    postedAt: null,
  };
  const postingApi = `https://api.eu.lever.co/v0/postings/acme/${id}`;

  test("reads one posting's ad from the postings API", async () => {
    const posting = {
      text: "Engineer",
      hostedUrl: listing.url,
      descriptionPlain: "Build payment APIs.",
      lists: [{ text: "You have", content: "<li>TypeScript</li>" }],
    };
    const { http, requests } = fakeHttp({ [postingApi]: JSON.stringify(posting) });
    const read = leverAdapter.fetchDescription;
    if (!read) throw new Error("Expected fetchDescription");
    const text = await read(listing).pipe(Effect.provide(atsLayer(http)), Effect.runPromise);
    expect(text).toStartWith("Build payment APIs.\n\nYou have\n");
    expect(text).toContain("TypeScript");
    expect(requests).toEqual([postingApi]);
    const other = await read({ ...listing, url: "https://jobs.lever.co/acme" }).pipe(
      Effect.flip,
      Effect.provide(atsLayer(http)),
      Effect.runPromise,
    );
    expect(other.message).toBe("Not a Lever job URL: https://jobs.lever.co/acme");
  });

  test("reads only posting URLs on the board hosts", () => {
    const describes = leverAdapter.describes ?? (() => true);
    expect(describes(`https://jobs.lever.co/acme/${id}`)).toBe(true);
    expect(describes("https://jobs.lever.co/acme")).toBe(false);
    expect(describes(`https://example.com/acme/${id}`)).toBe(false);
    expect(describes("not a url")).toBe(false);
  });
});
