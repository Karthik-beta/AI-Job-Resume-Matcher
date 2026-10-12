import { Layer, Schema } from "effect";
import { discordNotifierLayer } from "../matching/discord";
import { httpFetchLayer } from "../matching/download";
import { matchEvaluatorLayer } from "../matching/evaluate";
import { firecrawlLayer } from "../matching/firecrawl";
import { pdfParserLayer } from "../matching/pdf";
import { resumeSourceLayer } from "../matching/resume-source";
import { routingFromEnv } from "../matching/routing";

// Only the worker with live providers needs these keys.
const ProviderKeys = Schema.Struct({
  FIRECRAWL_API_KEY: Schema.NonEmptyString,
  OPENROUTER_API_KEY: Schema.NonEmptyString,
});

// Needs the PageCacheStore, which the caller provides.
export const liveProvidersLayer = (model: string) => {
  const keys = Schema.decodeUnknownSync(ProviderKeys)(process.env);
  const documents = Layer.mergeAll(
    firecrawlLayer(keys.FIRECRAWL_API_KEY),
    httpFetchLayer,
    pdfParserLayer,
  );
  return Layer.mergeAll(
    resumeSourceLayer.pipe(Layer.provideMerge(documents)),
    matchEvaluatorLayer({
      apiKey: keys.OPENROUTER_API_KEY,
      model,
      routing: routingFromEnv(process.env),
    }),
    discordNotifierLayer,
  );
};
