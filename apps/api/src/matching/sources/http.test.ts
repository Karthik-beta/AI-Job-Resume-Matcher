import { describe, expect, test } from "bun:test";
import { Clock, Effect, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { atsLayer, fakeHttp, type Reply } from "../../../test/ats";
import { fetchJson, makeHostLimiter } from "./http";

const Body = Schema.Struct({ ok: Schema.Boolean });
const request = { label: "Example", notFound: "Board 'x' not found." };

const get = (replies: Record<string, Reply>) => {
  const { http } = fakeHttp(replies);
  return fetchJson("https://api.example.com/x", Body, request).pipe(
    Effect.result,
    Effect.provide(atsLayer(http)),
    Effect.runPromise,
  );
};

describe("fetchJson", () => {
  test("decodes the JSON body", async () => {
    expect(await get({ "https://api.example.com/x": '{"ok":true}' })).toMatchObject({
      _tag: "Success",
      success: { ok: true },
    });
  });

  test.each<[string, Reply, number | null, string]>([
    ["a 404", { status: 404 }, 404, "Board 'x' not found."],
    ["a server error", { status: 503 }, 503, "Example returned HTTP 503."],
    ["invalid JSON", "<html>", 200, "Example returned invalid JSON."],
    ["an unexpected shape", '{"ok":"yes"}', 200, "Example returned unexpected data"],
  ])("fails on %s", async (_name, reply, status, message) => {
    const result = await get({ "https://api.example.com/x": reply });
    if (result._tag !== "Failure") throw new Error("Expected a failure");
    expect(result.failure).toMatchObject({ _tag: "ScrapeFailed", status });
    expect(result.failure.message).toStartWith(message);
  });

  test("fails when the network does", async () => {
    expect(await get({})).toMatchObject({ _tag: "Failure", failure: { status: null } });
  });
});

describe("HostLimiter", () => {
  test("spaces requests to the same host but not across hosts", async () => {
    const starts = await Effect.gen(function* () {
      const limiter = yield* makeHostLimiter(1_500);
      const at = (host: string) =>
        limiter.waitForTurn(host).pipe(
          Effect.andThen(Clock.currentTimeMillis),
          Effect.map((time) => `${host}@${time}`),
        );
      const fiber = yield* Effect.forkChild(
        Effect.all([at("a"), at("a"), at("b"), at("a")], { concurrency: "unbounded" }),
      );
      yield* TestClock.adjust("1 minute");
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise);
    expect(starts).toEqual(["a@0", "a@1500", "b@0", "a@3000"]);
  });
});
