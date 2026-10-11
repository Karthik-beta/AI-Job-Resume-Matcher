import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
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
      failure: { _tag: "NotifyFailed", message: "Discord request failed: Connection reset" },
    });
  });
});
