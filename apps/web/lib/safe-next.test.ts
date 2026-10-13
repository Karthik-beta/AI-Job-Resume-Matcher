/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { authHref, safeNext } from "./safe-next";

describe("safeNext", () => {
  test.each([
    ["/settings", "/settings"],
    ["/runs/abc123", "/runs/abc123"],
    ["/matches?status=applied", "/matches?status=applied"],
    ["/analyze#sources", "/analyze#sources"],
    ["/", "/"],
    ["/runs/../settings", "/settings"],
    ["/sign-in-help", "/sign-in-help"],
  ])("keeps %p", (next, expected) => {
    expect(safeNext(next)).toBe(expected);
  });

  test.each([
    null,
    undefined,
    "",
    "settings",
    "https://evil.com",
    "http://evil.com/home",
    "javascript:alert(1)",
    "//evil.com",
    "///evil.com",
    "/\\evil.com",
    "/\\/evil.com",
    "\\\\evil.com",
    "/%2F%2Fevil.com",
    "/%2F/evil.com",
    "/%5Cevil.com",
    "/%E0%A4%A",
    "/\t/evil.com",
    "/\n/evil.com",
    "/ /evil.com",
    "/home\u0000",
    "/sign-in",
    "/sign-up",
    "/sign-in/",
    "/SIGN-IN",
    "/sign-in?next=/home",
    "/%73ign-in",
    "/home/../sign-up",
    `/${"a".repeat(2048)}`,
  ])("refuses %p", (next) => {
    expect(safeNext(next)).toBeNull();
  });
});

describe("authHref", () => {
  test("carries a safe next page", () => {
    expect(authHref("/sign-up", "/runs/1?tab=all")).toBe("/sign-up?next=%2Fruns%2F1%3Ftab%3Dall");
  });

  test("drops an unsafe or missing next page", () => {
    expect(authHref("/sign-in", "//evil.com")).toBe("/sign-in");
    expect(authHref("/sign-in", null)).toBe("/sign-in");
  });
});
