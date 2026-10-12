import { Effect, Schema } from "effect";
import { ScrapeFailed } from "../errors";
import type { Listing } from "../firecrawl";
import { boardKey, type SourceAdapter } from "./adapter";
import { fetchJson } from "./http";
import { htmlToText, isoDate } from "./text";

const apiBase = "https://api.smartrecruiters.com/v1/companies";
const pageSize = 100;
// Big employers list thousands of postings; the newest 500 are plenty for one run.
const maxPages = 5;

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const PostingsPage = Schema.Struct({
  totalFound: Schema.Number,
  content: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      company: Schema.optional(Schema.NullOr(Schema.Struct({ name: OptionalString }))),
      releasedDate: OptionalString,
      location: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            fullLocation: OptionalString,
            remote: Schema.optional(Schema.NullOr(Schema.Boolean)),
          }),
        ),
      ),
    }),
  ),
});

const Section = Schema.optional(
  Schema.NullOr(Schema.Struct({ title: OptionalString, text: OptionalString })),
);

const PostingDetail = Schema.Struct({
  jobAd: Schema.Struct({
    sections: Schema.Struct({
      companyDescription: Section,
      jobDescription: Section,
      qualifications: Section,
      additionalInformation: Section,
    }),
  }),
});

type Posting = (typeof PostingsPage.Type)["content"][number];

// "bengaluru, , India" becomes "bengaluru, India".
const cleanLocation = (location: string) =>
  location
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");

const toListing = (posting: Posting, company: string): Listing => {
  const location = cleanLocation(posting.location?.fullLocation ?? "");
  return {
    title: posting.name,
    url: `https://jobs.smartrecruiters.com/${encodeURIComponent(company)}/${encodeURIComponent(posting.id)}`,
    company: posting.company?.name?.trim() || company,
    locations: location ? [location] : [],
    experienceMinYears: null,
    experienceMaxYears: null,
    remote: posting.location?.remote ?? null,
    postedAt: isoDate(posting.releasedDate),
  };
};

const jobPath = /^\/([^/]+)\/(\d+)/;

// The list has no job ad, so each selected job's ad is read from the posting API instead
// of fetching every posting up front or scraping the public page.
const fetchDescription = (listing: Listing) =>
  Effect.gen(function* () {
    const match = URL.canParse(listing.url) ? jobPath.exec(new URL(listing.url).pathname) : null;
    if (!match) {
      return yield* new ScrapeFailed({
        status: null,
        message: `Not a SmartRecruiters job URL: ${listing.url}`,
      });
    }
    const [, company, id] = match;
    const { jobAd } = yield* fetchJson(`${apiBase}/${company}/postings/${id}`, PostingDetail, {
      label: "SmartRecruiters",
      notFound: `SmartRecruiters posting '${id}' not found.`,
    });
    const { companyDescription, jobDescription, qualifications, additionalInformation } =
      jobAd.sections;
    return [jobDescription, qualifications, additionalInformation, companyDescription]
      .map((section) => {
        const text = htmlToText(section?.text ?? "");
        return text && section?.title ? `${section.title}\n${text}` : text;
      })
      .filter(Boolean)
      .join("\n\n");
  });

export const smartRecruitersAdapter: SourceAdapter = {
  fetchListings: (source) =>
    Effect.gen(function* () {
      const company = yield* boardKey(source, "SmartRecruiters");
      const postings: Posting[] = [];
      for (let page = 0; page < maxPages; page++) {
        const offset = page * pageSize;
        const { totalFound, content } = yield* fetchJson(
          `${apiBase}/${encodeURIComponent(company)}/postings?limit=${pageSize}&offset=${offset}`,
          PostingsPage,
          // An unknown company returns an empty list, not a 404.
          { label: "SmartRecruiters", notFound: `SmartRecruiters company '${company}' not found.` },
        );
        postings.push(...content);
        if (content.length === 0 || offset + content.length >= totalFound) break;
      }
      return postings.map((posting) => toListing(posting, company));
    }),
  fetchDescription,
};
