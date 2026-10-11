import { Injectable, Logger } from "@nestjs/common";
import { Effect } from "effect";
import { config } from "../config";
import { type MatchAlert, makeDiscordNotifier } from "../matching/discord";
import { fakeNotifier } from "../providers/fake";

// Discord alerts sent from the API. The worker sends its own through the Effect runtime.
@Injectable()
export class MatchAlerts {
  private readonly logger = new Logger(MatchAlerts.name);
  private readonly notifier =
    config.PROVIDERS === "fake" ? fakeNotifier : makeDiscordNotifier(fetch);

  // A failed alert is only logged, as in processRun: the match is already saved.
  send(webhookUrl: string, alert: MatchAlert) {
    return this.notifier.notifyMatch(webhookUrl, alert).pipe(
      Effect.catchTag("NotifyFailed", (error) =>
        Effect.sync(() => this.logger.warn(error.message)),
      ),
      Effect.runPromise,
    );
  }
}
