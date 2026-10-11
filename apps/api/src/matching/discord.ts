import { isDiscordWebhookUrl } from "@job-matcher/shared";
import { Context, Effect, Layer } from "effect";
import { NotifyFailed } from "./errors";

const timeoutMs = 10_000;
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

export const makeDiscordNotifier = (post: Post) =>
  Notifier.of({
    notifyMatch: (webhookUrl, alert) =>
      Effect.gen(function* () {
        if (!isDiscordWebhookUrl(webhookUrl)) {
          return yield* new NotifyFailed({ message: "The webhook URL is not a Discord webhook." });
        }
        const response = yield* Effect.tryPromise({
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
        if (!response.ok) {
          return yield* new NotifyFailed({ message: `Discord returned ${response.status}.` });
        }
      }),
  });

export const discordNotifierLayer = Layer.succeed(Notifier, makeDiscordNotifier(fetch));
