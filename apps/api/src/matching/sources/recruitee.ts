import { Effect, Schema } from "effect";
import type { Listing } from "../firecrawl";
import { boardKey, type SourceAdapter } from "./adapter";
import { fetchJson } from "./http";
import { experienceFromText, htmlToText, isoDate } from "./text";

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const RecruiteeOffers = Schema.Struct({
  offers: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      careers_url: Schema.String,
      company_name: OptionalString,
      description: OptionalString,
      requirements: OptionalString,
      location: OptionalString,
      city: OptionalString,
      country: OptionalString,
      remote: Schema.optional(Schema.NullOr(Schema.Boolean)),
      published_at: OptionalString,
    }),
  ),
});

type RecruiteeOffer = (typeof RecruiteeOffers.Type)["offers"][number];

// Recruitee dates look like "2026-10-05 16:05:18 UTC".
const recruiteeDate = (value: string | null | undefined) =>
  isoDate(value?.replace(/^(\S+) (\S+) UTC$/, "$1T$2Z"));

const toListing = (offer: RecruiteeOffer, company: string): Listing => {
  const description = [offer.description, offer.requirements]
    .map((html) => htmlToText(html ?? ""))
    .filter(Boolean)
    .join("\n\n");
  const location =
    offer.location?.trim() ||
    [offer.city, offer.country]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(", ");
  return {
    title: offer.title,
    url: offer.careers_url,
    company: offer.company_name?.trim() || company,
    locations: location ? [location] : [],
    ...experienceFromText(description),
    remote: offer.remote ?? null,
    postedAt: recruiteeDate(offer.published_at),
    ...(description ? { description } : {}),
  };
};

export const recruiteeAdapter: SourceAdapter = {
  fetchListings: (source) =>
    Effect.gen(function* () {
      const company = yield* boardKey(source, "Recruitee");
      const { offers } = yield* fetchJson(
        `https://${encodeURIComponent(company)}.recruitee.com/api/offers/`,
        RecruiteeOffers,
        { label: "Recruitee", notFound: `Recruitee company '${company}' not found.` },
      );
      return offers.map((offer) => toListing(offer, company));
    }),
};
