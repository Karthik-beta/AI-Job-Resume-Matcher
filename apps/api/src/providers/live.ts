import { Layer, Schema } from "effect";
import { discordNotifierLayer } from "../matching/discord";
import { httpFetchLayer } from "../matching/download";
import { matchEvaluatorLayer } from "../matching/evaluate";
import { firecrawlLayer } from "../matching/firecrawl";
import { listingExtractorLayer } from "../matching/listing-extractor";
import { pdfParserLayer } from "../matching/pdf";
import { resumeSourceLayer } from "../matching/resume-source";
import { routingFromEnv } from "../matching/routing";
import { hostLimiterLayer } from "../matching/sources/http";

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
  const openRouter = {
    apiKey: keys.OPENROUTER_API_KEY,
    model,
    routing: routingFromEnv(process.env),
  };
  return Layer.mergeAll(
    resumeSourceLayer.pipe(Layer.provideMerge(documents)),
    matchEvaluatorLayer(openRouter),
    listingExtractorLayer(openRouter),
    discordNotifierLayer,
    hostLimiterLayer,
  );
};
