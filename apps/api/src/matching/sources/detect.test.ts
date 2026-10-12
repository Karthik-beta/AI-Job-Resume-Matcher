import { describe, expect, test } from "bun:test";
import { detectSource } from "./detect";

describe("detectSource", () => {
  test.each([
    ["https://boards.greenhouse.io/stripe", "GREENHOUSE", "stripe"],
    ["https://job-boards.greenhouse.io/stripe/jobs/8172510", "GREENHOUSE", "stripe"],
    ["https://job-boards.eu.greenhouse.io/acme", "GREENHOUSE", "acme"],
    ["https://boards.eu.greenhouse.io/acme", "GREENHOUSE", "acme"],
    ["https://boards.greenhouse.io/embed/job_board?for=lattice", "GREENHOUSE", "lattice"],
    ["https://boards.greenhouse.io/embed/job_board/js?for=lattice", "GREENHOUSE", "lattice"],
    ["https://job-boards.greenhouse.io/embed/job_board?for=lattice", "GREENHOUSE", "lattice"],
    ["https://boards-api.greenhouse.io/v1/boards/stripe/jobs", "GREENHOUSE", "stripe"],
    ["https://jobs.lever.co/leverdemo", "LEVER", "leverdemo"],
    ["https://jobs.lever.co/leverdemo/ad208490-4052-4f91-a57e-433f2d1e484b", "LEVER", "leverdemo"],
    ["https://jobs.eu.lever.co/acme", "LEVER", "acme"],
    ["https://api.lever.co/v0/postings/leverdemo?mode=json", "LEVER", "leverdemo"],
    ["https://jobs.ashbyhq.com/ashby", "ASHBY", "ashby"],
    ["https://jobs.ashbyhq.com/ironcladhq/embed?version=2", "ASHBY", "ironcladhq"],
    ["https://api.ashbyhq.com/posting-api/job-board/ashby", "ASHBY", "ashby"],
    ["https://jobs.smartrecruiters.com/BoschGroup", "SMARTRECRUITERS", "BoschGroup"],
    ["https://careers.smartrecruiters.com/BoschGroup", "SMARTRECRUITERS", "BoschGroup"],
    [
      "https://api.smartrecruiters.com/v1/companies/BoschGroup/postings",
      "SMARTRECRUITERS",
      "BoschGroup",
    ],
    ["https://bunq.recruitee.com/", "RECRUITEE", "bunq"],
    ["https://bunq.recruitee.com/o/deputy-aml-manager-belgium", "RECRUITEE", "bunq"],
  ])("detects %s", (url, kind, adapterKey) => {
    expect(detectSource(url)).toEqual({ kind, adapterKey } as ReturnType<typeof detectSource>);
  });

  test.each([
    "https://example.com/careers",
    "not a url",
    "https://boards.greenhouse.io/",
    "https://boards.greenhouse.io/embed/job_board",
    "https://boards-api.greenhouse.io/v2/other",
    "https://api.lever.co/v1/other",
    "https://api.ashbyhq.com/other",
    "https://api.smartrecruiters.com/v1/other",
    "https://jobs.ashbyhq.com/api/non-user-graphql",
    "https://jobs.smartrecruiters.com/external-referrals/company/x",
    "https://www.recruitee.com/",
    "https://lever.co/careers",
    "https://jobs.lever.co/%E0%A4%A",
  ])("treats %s as a page", (url) => {
    expect(detectSource(url)).toEqual({ kind: "PAGE", adapterKey: null });
  });
});
