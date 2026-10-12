import { Effect, Schema } from "effect";
import type { Listing } from "../firecrawl";
import { boardKey, isEuSource, type SourceAdapter } from "./adapter";
import { fetchJson } from "./http";
import { decodeEntities, experienceFromText, htmlToText, isoDate } from "./text";

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const GreenhouseJobs = Schema.Struct({
  jobs: Schema.Array(
    Schema.Struct({
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
    }),
  ),
});

type GreenhouseJob = (typeof GreenhouseJobs.Type)["jobs"][number];

const mentionsRemote = (text: string) => /\bremote\b/i.test(text);

const toListing = (job: GreenhouseJob, token: string): Listing => {
  // The content field is HTML that is itself HTML-escaped.
  const description = htmlToText(decodeEntities(job.content ?? ""));
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

export const greenhouseAdapter: SourceAdapter = {
  fetchListings: (source) =>
    Effect.gen(function* () {
      const token = yield* boardKey(source, "Greenhouse");
      const host = isEuSource(source) ? "boards-api.eu.greenhouse.io" : "boards-api.greenhouse.io";
      const { jobs } = yield* fetchJson(
        `https://${host}/v1/boards/${encodeURIComponent(token)}/jobs?content=true`,
        GreenhouseJobs,
        { label: "Greenhouse", notFound: `Greenhouse board '${token}' not found.` },
      );
      return jobs.map((job) => toListing(job, token));
    }),
};
