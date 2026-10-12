import { Effect, Schema } from "effect";
import type { Listing } from "../firecrawl";
import { boardKey, type SourceAdapter } from "./adapter";
import { fetchJson } from "./http";
import { experienceFromText, isoDate } from "./text";

// Checked 2026-10-12: jobs.ashbyhq.com/robots.txt disallows only /meeting/, /b/ and /api/,
// api.ashbyhq.com has no robots.txt, and Ashby documents this posting API as the supported
// way to build a custom careers page.

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const AshbyBoard = Schema.Struct({
  jobs: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      jobUrl: Schema.String,
      location: OptionalString,
      secondaryLocations: Schema.optional(
        Schema.NullOr(Schema.Array(Schema.Struct({ location: OptionalString }))),
      ),
      isRemote: Schema.optional(Schema.NullOr(Schema.Boolean)),
      isListed: Schema.optional(Schema.NullOr(Schema.Boolean)),
      publishedAt: OptionalString,
      descriptionPlain: OptionalString,
      compensation: Schema.optional(
        Schema.NullOr(Schema.Struct({ compensationTierSummary: OptionalString })),
      ),
    }),
  ),
});

type AshbyJob = (typeof AshbyBoard.Type)["jobs"][number];

// The posting API has no company name, so the board name stands in for it.
const toListing = (job: AshbyJob, board: string): Listing => {
  const locations = [job.location, ...(job.secondaryLocations ?? []).map((s) => s.location)]
    .map((location) => location?.trim() ?? "")
    .filter(Boolean);
  const pay = job.compensation?.compensationTierSummary?.trim();
  const description = [job.descriptionPlain?.trim() ?? "", pay ? `Compensation: ${pay}` : ""]
    .filter(Boolean)
    .join("\n\n");
  return {
    title: job.title,
    url: job.jobUrl,
    company: board,
    locations: [...new Set(locations)],
    ...experienceFromText(description),
    remote: job.isRemote ?? null,
    postedAt: isoDate(job.publishedAt),
    ...(description ? { description } : {}),
  };
};

export const ashbyAdapter: SourceAdapter = {
  fetchListings: (source) =>
    Effect.gen(function* () {
      const board = yield* boardKey(source, "Ashby");
      const { jobs } = yield* fetchJson(
        `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`,
        AshbyBoard,
        { label: "Ashby", notFound: `Ashby board '${board}' not found.` },
      );
      const listed = jobs.filter((job) => job.isListed !== false);
      return { listings: listed.map((job) => toListing(job, board)) };
    }),
};
