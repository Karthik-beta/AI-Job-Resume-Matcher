import { Layer, Schema } from "effect";
import { discordNotifierLayer } from "../matching/discord";
import { httpFetchLayer } from "../matching/download";
import { matchEvaluatorLayer } from "../matching/evaluate";
import { listingExtractorLayer } from "../matching/listing-extractor";
import { pdfParserLayer } from "../matching/pdf";
import { resumeSourceLayer } from "../matching/resume-source";
import { routingFromEnv } from "../matching/routing";
import { firecrawlConfigFrom, firecrawlLayer } from "../matching/scrape-router";
import { hostLimiterLayer } from "../matching/sources/http";
import { titleTriageLayer } from "../matching/triage";

// Only the worker with live providers needs these settings.
const ProviderKeys = Schema.Struct({ OPENROUTER_API_KEY: Schema.NonEmptyString });

// Needs the PageCacheStore, which the caller provides.
export const liveProvidersLayer = (model: string) => {
  const keys = Schema.decodeUnknownSync(ProviderKeys)(process.env);
  const documents = Layer.mergeAll(
    firecrawlLayer(firecrawlConfigFrom(process.env)),
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
    titleTriageLayer(openRouter),
    discordNotifierLayer,
    hostLimiterLayer,
  );
};
