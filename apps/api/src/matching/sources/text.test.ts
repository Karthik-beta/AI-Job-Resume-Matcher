import { describe, expect, test } from "bun:test";
import { decodeEntities, experienceFromText, htmlToText, isoDate } from "./text";

describe("htmlToText", () => {
  test("keeps line breaks for blocks and dashes for list items", () => {
    const html =
      "<h2>About</h2><p>We&rsquo;re hiring &amp; growing.</p><ul><li>Go</li><li>SQL<br>Postgres</li></ul>" +
      "<script>alert(1)</script><style>p{}</style><div>Apply&nbsp;now &#8212; &#x2014; &bogus;</div>";
    expect(htmlToText(html)).toBe(
      "About\n\nWe’re hiring & growing.\n- Go\n- SQL\nPostgres\n\nApply now — — &bogus;",
    );
  });

  test("decodes escaped HTML before stripping it", () => {
    expect(htmlToText(decodeEntities("&lt;p&gt;Hi &amp;amp; bye&lt;/p&gt;"))).toBe("Hi & bye");
  });

  test("leaves invalid code points alone", () => {
    expect(decodeEntities("&#0; &#x110000;")).toBe("&#0; &#x110000;");
  });
});

describe("experienceFromText", () => {
  test.each([
    ["3+ years of SaaS experience", 3, null],
    ["2-5 years in backend roles", 2, 5],
    ["2 to 5 years", 2, 5],
    ["2–5 yrs of Go", 2, 5],
    ["5+ - 8 years", 5, 8],
    ["at least 4 years of experience", 4, null],
    ["a minimum of 4 years", 4, null],
    ["Min. 6 yrs", 6, null],
    ["8-5 years, then 3+ years", 3, null],
    ["Experience with Go", null, null],
    ["We have been around for 10 years", null, null],
  ])("reads %p", (text, min, max) => {
    expect(experienceFromText(text)).toEqual({
      experienceMinYears: min,
      experienceMaxYears: max,
    });
  });
});

describe("isoDate", () => {
  test.each([
    ["2026-09-09T10:50:29-04:00", "2026-09-09T14:50:29.000Z"],
    [1788199939703, "2026-08-31T18:12:19.703Z"],
    ["not a date", null],
    ["", null],
    [null, null],
    [undefined, null],
  ])("converts %p", (value, iso) => {
    expect(isoDate(value)).toBe(iso);
  });
});
