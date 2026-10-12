import { expect, test } from "bun:test";
import { adapterFor, descriptionReader } from "./registry";
import { searchAdapter } from "./search";

test("reads a search source with the search adapter", () => {
  expect(adapterFor("SEARCH")).toBe(searchAdapter);
});

test("reads a missing job ad from the API that can read its URL", () => {
  const jobUrl = "https://job-boards.greenhouse.io/acme/jobs/1";
  expect(descriptionReader("GREENHOUSE", jobUrl)).toBe(
    adapterFor("GREENHOUSE").fetchDescription ?? null,
  );
  // A job on the company's own site is scraped instead.
  expect(descriptionReader("GREENHOUSE", "https://acme.com/jobs?gh_jid=1")).toBeNull();
  expect(descriptionReader("SMARTRECRUITERS", "https://example.com/job")).not.toBeNull();
  expect(descriptionReader("ASHBY", "https://jobs.ashbyhq.com/acme/1")).toBeNull();
  expect(descriptionReader("PAGE", jobUrl)).toBeNull();
});
