import { isDiscordWebhookUrl } from "@job-matcher/shared";
import { Context, Duration, Effect, Layer } from "effect";
import { NotifyFailed } from "./errors";

const timeoutMs = 10_000;
// A 429 is retried after Discord's retry_after, at most twice and only for short waits, so a
// rate-limited webhook can't hold up the run for long.
const maxAttempts = 3;
const maxRetryWaitMs = 30_000;
// Discord rejects embed descriptions over 4096 characters.
const maxDescription = 4_000;

export interface MatchAlert {
  readonly title: string;
  readonly company: string;
  readonly jobUrl: string;
  readonly reason: string;
}

type Post = (url: string, init: RequestInit) => Promise<Response>;

export class Notifier extends Context.Service<
  Notifier,
  {
    readonly notifyMatch: (
      webhookUrl: string,
      alert: MatchAlert,
    ) => Effect.Effect<void, NotifyFailed>;
  }
>()("Notifier") {}

export const matchPayload = ({ title, company, jobUrl, reason }: MatchAlert) => ({
  embeds: [
    {
      title: "New job match",
      url: jobUrl,
      description: `**${title}** at **${company}**\n\n${reason}`.slice(0, maxDescription),
      color: 0x5865f2,
    },
  ],
  // The text comes from scraped pages, so it must never ping anyone.
  allowed_mentions: { parse: [] },
});

// Discord puts the wait in seconds in the 429 body.
const retryWaitMs = (response: Response) =>
  Effect.promise(async () => {
    const body = (await response.json().catch(() => null)) as { retry_after?: unknown } | null;
    const seconds = body?.retry_after;
    return typeof seconds === "number" && seconds >= 0 ? Math.ceil(seconds * 1000) : null;
  });

export const makeDiscordNotifier = (post: Post) => {
  const send = (webhookUrl: string, alert: MatchAlert) =>
    Effect.tryPromise({
      try: () =>
        post(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(matchPayload(alert)),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "error",
        }),
      // Only the error name is kept: a message can include the URL, and its path holds the token.
      catch: (cause) =>
        new NotifyFailed({
          message: `Discord request failed (${cause instanceof Error ? cause.name : "unknown error"}).`,
        }),
    });

  return Notifier.of({
    notifyMatch: (webhookUrl, alert) =>
      Effect.gen(function* () {
        if (!isDiscordWebhookUrl(webhookUrl)) {
          return yield* new NotifyFailed({ message: "The webhook URL is not a Discord webhook." });
        }
        for (let attempt = 1; ; attempt++) {
          const response = yield* send(webhookUrl, alert);
          if (response.ok) return;
          if (response.status !== 429 || attempt === maxAttempts) {
            return yield* new NotifyFailed({ message: `Discord returned ${response.status}.` });
          }
          const waitMs = yield* retryWaitMs(response);
          if (waitMs === null || waitMs > maxRetryWaitMs) {
            return yield* new NotifyFailed({
              message: "Discord returned 429 without a short enough retry_after.",
            });
          }
          yield* Effect.sleep(Duration.millis(waitMs));
        }
      }),
  });
};

export const discordNotifierLayer = Layer.succeed(Notifier, makeDiscordNotifier(fetch));
