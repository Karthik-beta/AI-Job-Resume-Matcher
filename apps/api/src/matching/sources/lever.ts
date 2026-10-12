import { Effect, Schema } from "effect";
import { ScrapeFailed } from "../errors";
import type { Listing } from "../firecrawl";
import { boardKey, isEuSource, type SourceAdapter } from "./adapter";
import { fetchJson } from "./http";
import { experienceFromText, htmlToText, isoDate } from "./text";

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const LeverPosting = Schema.Struct({
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
});

const LeverPostings = Schema.Array(LeverPosting);

type LeverPosting = typeof LeverPosting.Type;

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

// A job ad on a Lever board host: /{company}/{id}.
const postingOf = (url: string) => {
  if (!URL.canParse(url)) return null;
  const { hostname, pathname } = new URL(url);
  const host = hostname.toLowerCase();
  if (host !== "jobs.lever.co" && host !== "jobs.eu.lever.co") return null;
  const match = /^\/([^/]+)\/([0-9a-f-]{36})/i.exec(pathname);
  if (!match) return null;
  const api = host === "jobs.eu.lever.co" ? "api.eu.lever.co" : "api.lever.co";
  return { api, company: match[1] ?? "", id: match[2] ?? "" };
};

// For a listing that came without its ad, such as a search result.
const fetchDescription = (listing: Listing) =>
  Effect.gen(function* () {
    const posting = postingOf(listing.url);
    if (!posting) {
      return yield* new ScrapeFailed({
        status: null,
        message: `Not a Lever job URL: ${listing.url}`,
      });
    }
    const found = yield* fetchJson(
      `https://${posting.api}/v0/postings/${encodeURIComponent(posting.company)}/${posting.id}`,
      LeverPosting,
      { label: "Lever", notFound: `Lever posting '${posting.id}' not found.` },
    );
    return descriptionOf(found);
  });

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
      return { listings: postings.map((posting) => toListing(posting, company)) };
    }),
  fetchDescription,
  describes: (url) => postingOf(url) !== null,
};
