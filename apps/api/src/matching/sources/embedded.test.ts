import { describe, expect, test } from "bun:test";
import { fixture } from "../../../test/ats";
import { detectEmbeddedBoard } from "./embedded";

describe("detectEmbeddedBoard", () => {
  test("finds the Greenhouse embed script on a careers page", async () => {
    const html = await fixture("career-embed-greenhouse.html");
    expect(detectEmbeddedBoard(html, [])).toEqual({ kind: "GREENHOUSE", adapterKey: "lattice" });
  });

  test("finds the Ashby embed on a careers page", async () => {
    const html = await fixture("career-embed-ashby.html");
    expect(detectEmbeddedBoard(html, [])).toEqual({ kind: "ASHBY", adapterKey: "ironcladhq" });
  });

  test.each([
    ['<iframe src="//job-boards.greenhouse.io/embed/job_board?for=acme&amp;b=1">', "GREENHOUSE"],
    ['<a href="https://jobs.lever.co/acme/123">Apply</a>', "LEVER"],
    ['<a href="https://careers.smartrecruiters.com/acme">Jobs</a>', "SMARTRECRUITERS"],
    ["<script>load('https://acme.recruitee.com/api/offers')</script>", "RECRUITEE"],
  ])("reads %s", (html, kind) => {
    expect(detectEmbeddedBoard(html, [])).toMatchObject({ kind });
  });

  test("prefers the page's links and ignores other ATS URLs", () => {
    const html =
      '<a href="https://www.lever.co/">Lever</a> <a href="https://jobs.ashbyhq.com/acme-b">';
    expect(
      detectEmbeddedBoard(html, ["https://example.com/", "https://jobs.lever.co/acme"]),
    ).toEqual({ kind: "LEVER", adapterKey: "acme" });
    expect(detectEmbeddedBoard(html, [])).toEqual({ kind: "ASHBY", adapterKey: "acme-b" });
    expect(detectEmbeddedBoard('<a href="https://www.lever.co/">', [])).toBeNull();
  });
});
