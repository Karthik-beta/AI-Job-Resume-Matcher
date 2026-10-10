import { describe, expect, test } from "bun:test";
import { retryAfterMs } from "./retry-after";

const now = Date.parse("2026-01-01T00:00:00Z");

describe("retryAfterMs", () => {
  test("reads delay seconds and adds a one second margin", () => {
    expect(retryAfterMs("30", now)).toBe(31_000);
    expect(retryAfterMs(" 1.5 ", now)).toBe(2_500);
  });

  test("clamps negative seconds to the margin", () => {
    expect(retryAfterMs("-5", now)).toBe(1_000);
  });

  test("reads an HTTP date relative to now", () => {
    expect(retryAfterMs("Thu, 01 Jan 2026 00:00:10 GMT", now)).toBe(11_000);
  });

  test("treats a past HTTP date as no wait beyond the margin", () => {
    expect(retryAfterMs("Wed, 31 Dec 2025 23:59:00 GMT", now)).toBe(1_000);
  });

  test.each([undefined, null, "", "   ", "soon", "12abc"])(
    "falls back to 61 seconds for %p",
    (header) => {
      expect(retryAfterMs(header, now)).toBe(61_000);
    },
  );
});
