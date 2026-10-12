import { Effect, Schema } from "effect";
import type { Listing } from "../firecrawl";
import { boardKey, isEuSource, type SourceAdapter } from "./adapter";
import { fetchJson } from "./http";
import { experienceFromText, htmlToText, isoDate } from "./text";

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const LeverPostings = Schema.Array(
  Schema.Struct({
    text: Schema.String,
    hostedUrl: Schema.String,
    descriptionPlain: OptionalString,
    lists: Schema.optional(
      Schema.NullOr(Schema.Array(Schema.Struct({ text: OptionalString, content: OptionalString }))),
    ),
    additionalPlain: OptionalString,
    categories: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          location: OptionalString,
          allLocations: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
        }),
      ),
    ),
    workplaceType: OptionalString,
    createdAt: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
);

type LeverPosting = (typeof LeverPostings.Type)[number];

const remoteByWorkplace: Record<string, boolean> = { remote: true, onsite: false, hybrid: false };

const descriptionOf = (posting: LeverPosting) =>
  [
    posting.descriptionPlain ?? "",
    ...(posting.lists ?? []).map((list) =>
      [list.text ?? "", htmlToText(list.content ?? "")].filter(Boolean).join("\n"),
    ),
    posting.additionalPlain ?? "",
  ]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");

// Lever has no company name field, so the board slug stands in for it.
const toListing = (posting: LeverPosting, company: string): Listing => {
  const description = descriptionOf(posting);
  const all = posting.categories?.allLocations ?? [];
  const location = posting.categories?.location?.trim();
  return {
    title: posting.text,
    url: posting.hostedUrl,
    company,
    locations: all.length > 0 ? [...all] : location ? [location] : [],
    ...experienceFromText(description),
    remote: remoteByWorkplace[posting.workplaceType?.toLowerCase() ?? ""] ?? null,
    postedAt: isoDate(posting.createdAt),
    ...(description ? { description } : {}),
  };
};

export const leverAdapter: SourceAdapter = {
  fetchListings: (source) =>
    Effect.gen(function* () {
      const company = yield* boardKey(source, "Lever");
      const host = isEuSource(source) ? "api.eu.lever.co" : "api.lever.co";
      const postings = yield* fetchJson(
        `https://${host}/v0/postings/${encodeURIComponent(company)}?mode=json`,
        LeverPostings,
        { label: "Lever", notFound: `Lever board '${company}' not found.` },
      );
      return postings.map((posting) => toListing(posting, company));
    }),
};
