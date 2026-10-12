import { describe, expect, test } from "bun:test";
import { fetchListings, fixture } from "../../../test/ats";
import { recruiteeAdapter } from "./recruitee";

const apiUrl = "https://bunq.recruitee.com/api/offers/";
const source = {
  url: "https://bunq.recruitee.com/",
  kind: "RECRUITEE",
  adapterKey: "bunq",
} as const;

describe("Recruitee adapter", () => {
  test("maps the offers API to listings", async () => {
    const { result, requests } = await fetchListings(recruiteeAdapter, source, {
      [apiUrl]: await fixture("recruitee.json"),
    });
    expect(requests).toEqual([apiUrl]);
    if (result._tag !== "Success") throw new Error(result.failure.message);
    const [first] = result.success;
    expect(result.success).toHaveLength(2);
    expect(first).toMatchObject({
      title: "Deputy AML Manager - Belgium",
      url: "https://careers.bunq.com/o/deputy-aml-manager-belgium",
      company: "bunq",
      locations: ["Brussels, Brussels, Belgium"],
      remote: false,
      postedAt: "2026-10-05T16:05:18.000Z",
    });
    expect(first?.description).toStartWith("Ready to Get Shit Done?");
    expect(first?.description).toContain("Do You Have What It Takes?");
    expect(first?.description).not.toContain("<");
  });

  test("builds the location from the city and country and fills in missing fields", async () => {
    const offers = [
      {
        title: "Engineer",
        careers_url: "https://acme.recruitee.com/o/engineer",
        city: "Delft",
        country: "Netherlands",
        remote: true,
        requirements: "<ul><li>At least 5 years of Elixir</li></ul>",
        published_at: "yesterday",
      },
      { title: "Designer", careers_url: "https://acme.recruitee.com/o/designer" },
    ];
    const { result } = await fetchListings(
      recruiteeAdapter,
      { ...source, adapterKey: "acme" },
      { "https://acme.recruitee.com/api/offers/": JSON.stringify({ offers }) },
    );
    if (result._tag !== "Success") throw new Error(result.failure.message);
    expect(result.success).toEqual([
      {
        title: "Engineer",
        url: "https://acme.recruitee.com/o/engineer",
        company: "acme",
        locations: ["Delft, Netherlands"],
        experienceMinYears: 5,
        experienceMaxYears: null,
        remote: true,
        postedAt: null,
        description: "- At least 5 years of Elixir",
      },
      {
        title: "Designer",
        url: "https://acme.recruitee.com/o/designer",
        company: "acme",
        locations: [],
        experienceMinYears: null,
        experienceMaxYears: null,
        remote: null,
        postedAt: null,
      },
    ]);
  });

  test("names a missing company", async () => {
    const { result } = await fetchListings(recruiteeAdapter, source, { [apiUrl]: { status: 404 } });
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { message: "Recruitee company 'bunq' not found." },
    });
  });
});
