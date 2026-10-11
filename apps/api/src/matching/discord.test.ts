import { describe, expect, test } from "bun:test";
import { type Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { makeDiscordNotifier } from "./discord";

const alert = {
  title: "Backend Engineer",
  company: "Example",
  jobUrl: "https://jobs.example.com/1",
  reason: "Strong fit",
};
const webhook = "https://discord.com/api/webhooks/1/token";

const notify = (post: (url: string, init: RequestInit) => Promise<Response>) =>
  makeDiscordNotifier(post).notifyMatch(webhook, alert).pipe(Effect.result, Effect.runPromise);

const rateLimited = (retryAfter: number | null) =>
  new Response(retryAfter === null ? null : JSON.stringify({ retry_after: retryAfter }), {
    status: 429,
  });

// Replays the scripted responses in order on a test clock, so retry waits take no real time.
const scripted = (responses: readonly (() => Response)[]) => {
  let calls = 0;
  const notifier = makeDiscordNotifier(async () => {
    const next = responses[Math.min(calls, responses.length - 1)];
    calls++;
    return next ? next() : new Response(null, { status: 204 });
  });
  const run = (steps: readonly Duration.Input[] = ["1 hour"]) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.result(notifier.notifyMatch(webhook, alert)));
      const seen: number[] = [];
      for (const step of steps) {
        yield* TestClock.adjust(step);
        seen.push(calls);
      }
      return { outcome: yield* Fiber.join(fiber), seen, calls };
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise);
  return { run };
};

describe("Discord notifier", () => {
  test("posts the match as an embed", async () => {
    const sent: { url: string; body: unknown }[] = [];
    const outcome = await notify(async (url, init) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(null, { status: 204 });
    });
    expect(outcome._tag).toBe("Success");
    expect(sent).toEqual([
      {
        url: webhook,
        body: {
          embeds: [
            {
              title: "New job match",
              url: alert.jobUrl,
              description: "**Backend Engineer** at **Example**\n\nStrong fit",
              color: 0x5865f2,
            },
          ],
          allowed_mentions: { parse: [] },
        },
      },
    ]);
  });

  test("fails with NotifyFailed on an error status", async () => {
    const outcome = await notify(async () => new Response(null, { status: 404 }));
    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "NotifyFailed", message: "Discord returned 404." },
    });
  });

  test("fails with NotifyFailed when the request throws", async () => {
    const outcome = await notify(async () => {
      throw new Error("Connection reset");
    });
    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "NotifyFailed", message: "Discord request failed (Error)." },
    });
  });

  test.each([
    "https://example.com/api/webhooks/1/token",
    "http://discord.com/api/webhooks/1/token",
    "https://discord.com/channels/1",
  ])("refuses %p without sending a request", async (url) => {
    let sent = 0;
    const outcome = await makeDiscordNotifier(async () => {
      sent++;
      return new Response(null, { status: 204 });
    })
      .notifyMatch(url, alert)
      .pipe(Effect.result, Effect.runPromise);
    expect(outcome).toMatchObject({ _tag: "Failure", failure: { _tag: "NotifyFailed" } });
    expect(sent).toBe(0);
  });

  test("retries a 429 after retry_after", async () => {
    const { run } = scripted([() => rateLimited(1.5), () => new Response(null, { status: 204 })]);
    const { outcome, seen } = await run(["1499 millis", "1 milli"]);
    expect(seen).toEqual([1, 2]);
    expect(outcome._tag).toBe("Success");
  });

  test("gives up after three attempts", async () => {
    const { run } = scripted([() => rateLimited(0.5)]);
    const { outcome, calls } = await run();
    expect(calls).toBe(3);
    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "NotifyFailed", message: "Discord returned 429." },
    });
  });

  test.each([
    ["a wait over the cap", () => rateLimited(31)],
    ["no retry hint", () => rateLimited(null)],
  ])("does not retry a 429 with %s", async (_, response) => {
    const { run } = scripted([response, () => new Response(null, { status: 204 })]);
    const { outcome, calls } = await run();
    expect(calls).toBe(1);
    expect(outcome).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "NotifyFailed",
        message: "Discord returned 429 without a short enough retry_after.",
      },
    });
  });
});
