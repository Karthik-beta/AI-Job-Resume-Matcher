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
});

export const makeDiscordNotifier = (post: Post) =>
  Notifier.of({
    notifyMatch: (webhookUrl, alert) =>
      Effect.tryPromise({
        try: () =>
          post(webhookUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(matchPayload(alert)),
            signal: AbortSignal.timeout(timeoutMs),
          }),
        catch: (cause) =>
          new NotifyFailed({
            message: `Discord request failed: ${cause instanceof Error ? cause.message : cause}`,
          }),
      }).pipe(
        Effect.flatMap((response) =>
          response.ok
            ? Effect.void
            : Effect.fail(new NotifyFailed({ message: `Discord returned ${response.status}.` })),
        ),
      ),
  });

export const discordNotifierLayer = Layer.succeed(Notifier, makeDiscordNotifier(fetch));
