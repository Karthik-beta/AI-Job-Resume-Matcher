import { Effect, Schema } from "effect";
import { ScrapeFailed } from "../errors";
import type { Listing } from "../firecrawl";
import { boardKey, type SourceAdapter } from "./adapter";
import { fetchJson } from "./http";
import { decodeEntities, experienceFromText, htmlToText, isoDate } from "./text";

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const GreenhouseJob = Schema.Struct({
  title: Schema.String,
  absolute_url: Schema.String,
  company_name: OptionalString,
  location: Schema.optional(Schema.NullOr(Schema.Struct({ name: OptionalString }))),
  content: OptionalString,
  first_published: OptionalString,
  updated_at: OptionalString,
  metadata: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Struct({ name: OptionalString, value: Schema.Unknown }))),
  ),
});

const GreenhouseJobs = Schema.Struct({ jobs: Schema.Array(GreenhouseJob) });

type GreenhouseJob = typeof GreenhouseJob.Type;

const apiBase = "https://boards-api.greenhouse.io/v1/boards";

const mentionsRemote = (text: string) => /\bremote\b/i.test(text);

// The content field is HTML that is itself HTML-escaped.
const descriptionOf = (job: GreenhouseJob) => htmlToText(decodeEntities(job.content ?? ""));

const toListing = (job: GreenhouseJob, token: string): Listing => {
  const description = descriptionOf(job);
  const location = job.location?.name?.trim() ?? "";
  const metadata = JSON.stringify(job.metadata ?? []);
  return {
    title: job.title,
    url: job.absolute_url,
    company: job.company_name?.trim() || token,
    locations: location ? [location] : [],
    ...experienceFromText(description),
    remote: mentionsRemote(location) || mentionsRemote(metadata) ? true : null,
    postedAt: isoDate(job.first_published) ?? isoDate(job.updated_at),
    ...(description ? { description } : {}),
  };
};

// A job ad on a Greenhouse board host: /{token}/jobs/{id}.
const jobOf = (url: string) => {
  if (!URL.canParse(url)) return null;
  const { hostname, pathname } = new URL(url);
  if (!/^(job-)?boards(\.eu)?\.greenhouse\.io$/.test(hostname.toLowerCase())) return null;
  const match = /^\/([^/]+)\/jobs\/(\d+)/.exec(pathname);
  return match ? { token: match[1] ?? "", id: match[2] ?? "" } : null;
};

// For a listing that came without its ad, such as a search result.
const fetchDescription = (listing: Listing) =>
  Effect.gen(function* () {
    const job = jobOf(listing.url);
    if (!job) {
      return yield* new ScrapeFailed({
        status: null,
        message: `Not a Greenhouse job URL: ${listing.url}`,
      });
    }
    const found = yield* fetchJson(
      `${apiBase}/${encodeURIComponent(job.token)}/jobs/${job.id}?content=true`,
      GreenhouseJob,
      { label: "Greenhouse", notFound: `Greenhouse job '${job.id}' not found.` },
    );
    return descriptionOf(found);
  });

export const greenhouseAdapter: SourceAdapter = {
  fetchListings: (source) =>
    Effect.gen(function* () {
      const token = yield* boardKey(source, "Greenhouse");
      const { jobs } = yield* fetchJson(
        // There is no EU Job Board API host (boards-api.eu.greenhouse.io does not resolve).
        `${apiBase}/${encodeURIComponent(token)}/jobs?content=true`,
        GreenhouseJobs,
        { label: "Greenhouse", notFound: `Greenhouse board '${token}' not found.` },
      );
      return { listings: jobs.map((job) => toListing(job, token)) };
    }),
  fetchDescription,
  // A job on the company's own site (absolute_url with ?gh_jid=) is scraped instead.
  describes: (url) => jobOf(url) !== null,
};
