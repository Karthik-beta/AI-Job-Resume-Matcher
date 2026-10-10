import { describe, expect, test } from "bun:test";
import {
  FirecrawlBlocked,
  firecrawlErrorFromStatus,
  ManagementKeyError,
  type MatchingError,
  MatchOutputInvalid,
  ModelUnsupported,
  NotifyFailed,
  OpenRouterAuthError,
  OpenRouterUnavailable,
  openRouterErrorFromStatus,
  SaveFailed,
  ScrapeFailed,
  stopsRun,
} from "./errors";

describe("stopsRun", () => {
  test.each<MatchingError>([
    new OpenRouterAuthError({ status: 401, message: "bad key" }),
    new OpenRouterUnavailable({ status: 429, message: "rate limited" }),
    new ManagementKeyError({ message: "bad management key" }),
    new ModelUnsupported({ model: "x/y", message: "no structured outputs" }),
    new FirecrawlBlocked({ status: 402, message: "out of credits" }),
  ])("stops the run on $_tag", (error) => {
    expect(stopsRun(error)).toBe(true);
  });

  test.each<MatchingError>([
    new ScrapeFailed({ status: 500, message: "server error" }),
    new MatchOutputInvalid({ message: "empty" }),
    new SaveFailed({ message: "db down" }),
    new NotifyFailed({ message: "webhook failed" }),
  ])("continues the run on $_tag", (error) => {
    expect(stopsRun(error)).toBe(false);
  });
});

describe("openRouterErrorFromStatus", () => {
  test("maps 401 to an auth error", () => {
    expect(openRouterErrorFromStatus(401, "nope")?._tag).toBe("OpenRouterAuthError");
  });

  test.each([402, 403, 404, 429])("maps %p to unavailable", (status) => {
    const error = openRouterErrorFromStatus(status, "nope");
    expect(error?._tag).toBe("OpenRouterUnavailable");
    expect(error?.status).toBe(status);
  });

  test.each([400, 500, 503])("leaves %p unmapped", (status) => {
    expect(openRouterErrorFromStatus(status, "nope")).toBeNull();
  });
});

describe("firecrawlErrorFromStatus", () => {
  test.each([401, 402, 429])("maps %p to blocked", (status) => {
    expect(firecrawlErrorFromStatus(status, "nope")._tag).toBe("FirecrawlBlocked");
  });

  test.each([400, 403, 404, 500])("maps %p to a failed scrape", (status) => {
    const error = firecrawlErrorFromStatus(status, "nope");
    expect(error._tag).toBe("ScrapeFailed");
    expect(error.status).toBe(status);
  });
});
