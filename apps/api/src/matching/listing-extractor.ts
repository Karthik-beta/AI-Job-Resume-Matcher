import { OpenRouterClient } from "@effect/ai-openrouter";
import { Context, Effect, Layer, Schema } from "effect";
import { type CompletionError, jsonCompletion, openRouterLayer } from "./completion";
import { MatchOutputInvalid } from "./errors";
import type { Listing } from "./firecrawl";
import type { Routing } from "./routing";

export interface ExtractionInput {
  // The careers page, to resolve relative links against.
  readonly url: string;
  readonly markdown: string;
}

// Reads job listings from a careers page's markdown with the model, for pages whose links
// the rules in sources/page-links.ts cannot read.
export class ListingExtractor extends Context.Service<
  ListingExtractor,
  {
    readonly extract: (
      input: ExtractionInput,
    ) => Effect.Effect<readonly Listing[], CompletionError>;
  }
>()("ListingExtractor") {}

export const extractionPrompt =
  "Extract only individual job listings explicitly present on this careers page. " +
  "Copy their titles and companies and return actual job-detail URLs, " +
  "resolving relative links against the page URL. Exclude navigation, " +
  "search pages and company profiles. Extract locations and minimum/maximum " +
  "years of experience only when explicitly stated for that listing. " +
  "Use an empty locations list and null experience bounds when unstated. " +
  "For '3+ years', use minimum 3 and maximum null. Do not invent jobs " +
  "or infer location or experience from titles.";

const years = (description: string) => ({ type: ["number", "null"], description });

export const listingsJsonSchema = {
  type: "object",
  properties: {
    jobs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Job title" },
          url: { type: "string", description: "URL of the job posting" },
          company: { type: "string", description: "Company name" },
          locations: {
            type: "array",
            items: { type: "string" },
            description: "Job locations explicitly stated in the listing; empty if unstated",
          },
          experience_min_years: years(
            "Minimum required years of experience explicitly stated; null if unstated",
          ),
          experience_max_years: years(
            "Maximum years of experience explicitly stated; null for open-ended or unstated requirements",
          ),
        },
        required: [
          "title",
          "url",
          "company",
          "locations",
          "experience_min_years",
          "experience_max_years",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["jobs"],
  additionalProperties: false,
};

const Years = Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)));

const ListingsJson = Schema.Struct({
  jobs: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      url: Schema.String,
      company: Schema.String,
      locations: Schema.Array(Schema.String),
      experience_min_years: Years,
      experience_max_years: Years,
    }),
  ),
});

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ListingsJson));

export const decodeListingsOutput = (
  content: string | null | undefined,
  refusal?: string | null | undefined,
) => {
  if (refusal) {
    return Effect.fail(new MatchOutputInvalid({ message: `Model refused: ${refusal}` }));
  }
  return decodeJson(content ?? "").pipe(
    Effect.map(({ jobs }) =>
      jobs.map(
        (job): Listing => ({
          title: job.title,
          url: job.url,
          company: job.company,
          locations: job.locations,
          experienceMinYears: job.experience_min_years,
          experienceMaxYears: job.experience_max_years,
          remote: null,
          postedAt: null,
        }),
      ),
    ),
    Effect.mapError(
      (error) => new MatchOutputInvalid({ message: `Invalid listings: ${error.message}` }),
    ),
  );
};

export const makeListingExtractor = (model: string, routing: Routing) =>
  Effect.gen(function* () {
    const openRouter = yield* OpenRouterClient.OpenRouterClient;
    return ListingExtractor.of({
      extract: ({ url, markdown }) =>
        jsonCompletion(openRouter, {
          model,
          routing,
          purpose: "listing extraction",
          system: extractionPrompt,
          user: `Page URL: ${url}\n\nPage markdown:\n${markdown}`,
          schemaName: "job_listings",
          schema: listingsJsonSchema,
          // A long board needs room for every listing on top of the reasoning tokens.
          maxTokens: 16_000,
        }).pipe(Effect.flatMap(({ content, refusal }) => decodeListingsOutput(content, refusal))),
    });
  });

export const listingExtractorLayer = (options: {
  readonly apiKey: string;
  readonly model: string;
  readonly routing: Routing;
}) =>
  Layer.effect(ListingExtractor, makeListingExtractor(options.model, options.routing)).pipe(
    Layer.provide(openRouterLayer(options.apiKey)),
  );
