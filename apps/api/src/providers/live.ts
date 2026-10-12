import { Layer, Schema } from "effect";
import { discordNotifierLayer } from "../matching/discord";
import { matchEvaluatorLayer } from "../matching/evaluate";
import { firecrawlLayer } from "../matching/firecrawl";
import { routingFromEnv } from "../matching/routing";

// Only the worker with live providers needs these keys.
const ProviderKeys = Schema.Struct({
  FIRECRAWL_API_KEY: Schema.NonEmptyString,
  OPENROUTER_API_KEY: Schema.NonEmptyString,
});

export const liveProvidersLayer = (model: string) => {
  const keys = Schema.decodeUnknownSync(ProviderKeys)(process.env);
  return Layer.mergeAll(
    firecrawlLayer(keys.FIRECRAWL_API_KEY),
    matchEvaluatorLayer({
      apiKey: keys.OPENROUTER_API_KEY,
      model,
      routing: routingFromEnv(process.env),
    }),
    discordNotifierLayer,
  );
};
