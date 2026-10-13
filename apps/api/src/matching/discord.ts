import { isDiscordWebhookUrl } from "@job-matcher/shared";
import { Context, Duration, Effect, Layer } from "effect";
import { NotifyFailed } from "./errors";

const timeoutMs = 10_000;
// A 429 is retried after Discord's Retry-After, at most twice and only for short waits, so a
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
  // The run's page in the web app, where the match can be reviewed.
  readonly runUrl: string;
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

export const matchPayload = ({ title, company, jobUrl, reason, runUrl }: MatchAlert) => {
  // The title links to the listing. The run link goes last, so a long reason can't cut it off.
  const runLink = `\n\n[Open the run in Job Matcher](${runUrl})`;
  const text = `**${title}** at **${company}**\n\n${reason}`;
  return {
    embeds: [
      {
        title: "New job match",
        url: jobUrl,
        description: `${text.slice(0, maxDescription - runLink.length)}${runLink}`,
        color: 0x5865f2,
      },
    ],
    // The text comes from scraped pages, so it must never ping anyone.
    allowed_mentions: { parse: [] },
  };
};

// Retry-After is in seconds on every API version. The body's retry_after is in milliseconds
// before v8, and webhook URLs don't pick a version.
const retryWaitMs = (response: Response) => {
  const seconds = Number(response.headers.get("retry-after") ?? Number.NaN);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : null;
};

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
          const waitMs = retryWaitMs(response);
          if (waitMs === null || waitMs > maxRetryWaitMs) {
            return yield* new NotifyFailed({
              message: "Discord returned 429 without a short enough Retry-After.",
            });
          }
          yield* Effect.sleep(Duration.millis(waitMs));
        }
      }),
  });
};

export const discordNotifierLayer = Layer.succeed(Notifier, makeDiscordNotifier(fetch));
