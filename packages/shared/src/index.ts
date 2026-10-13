import { Schema } from "effect";

const isHttpUrl = (value: string) => {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === "http:" || protocol === "https:";
};

export const HttpUrl = Schema.Trimmed.check(
  Schema.makeFilter(isHttpUrl, { message: "Enter a valid http or https URL" }),
);

const discordHosts: ReadonlySet<string> = new Set([
  "discord.com",
  "discordapp.com",
  "ptb.discord.com",
  "canary.discord.com",
]);

export const isDiscordWebhookUrl = (value: string) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    discordHosts.has(url.hostname) &&
    url.pathname.startsWith("/api/webhooks/")
  );
};

const DiscordWebhookUrl = Schema.Trimmed.check(
  Schema.makeFilter(isDiscordWebhookUrl, { message: "Enter a Discord webhook URL" }),
);

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

export const CreateJobSource = Schema.Struct({ url: HttpUrl });
export type CreateJobSource = typeof CreateJobSource.Type;

export const maxSearchQueryLength = 200;

// A web search of the ATS job boards for the past week's ads.
export const CreateSearchSource = Schema.Struct({
  query: Schema.Trim.check(
    Schema.makeFilter((query) => query !== "", { message: "Enter what to search for" }),
    Schema.makeFilter((query) => query.length <= maxSearchQueryLength, {
      message: `Use at most ${maxSearchQueryLength} characters`,
    }),
  ),
});
export type CreateSearchSource = typeof CreateSearchSource.Type;

export const SourceKind = Schema.Literals([
  "GREENHOUSE",
  "LEVER",
  "ASHBY",
  "SMARTRECRUITERS",
  "RECRUITEE",
  "SEARCH",
  "PAGE",
]);
export type SourceKind = typeof SourceKind.Type;

// Kinds read from a public ATS API, keyed by the board token or company slug.
export const atsKinds: ReadonlySet<SourceKind> = new Set([
  "GREENHOUSE",
  "LEVER",
  "ASHBY",
  "SMARTRECRUITERS",
  "RECRUITEE",
]);

export const sourceKindLabels: Record<SourceKind, string> = {
  GREENHOUSE: "Greenhouse",
  LEVER: "Lever",
  ASHBY: "Ashby",
  SMARTRECRUITERS: "SmartRecruiters",
  RECRUITEE: "Recruitee",
  SEARCH: "Search",
  PAGE: "Web page",
};

// Search sources are created from a query, not by switching an existing source.
export const UpdateJobSource = Schema.Struct({
  kind: SourceKind.check(
    Schema.makeFilter((kind) => kind !== "SEARCH", {
      message: "A source cannot be switched to search",
    }),
  ),
  // The characters a board name has in an ATS URL, as the API's source detection reads it.
  adapterKey: Schema.NullOr(
    Schema.Trim.check(
      Schema.makeFilter((key) => key === "" || /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(key), {
        message: "Use only letters, numbers, dots, dashes and underscores in the board name",
      }),
    ),
  ),
  // Page sources only: read job links from Firecrawl's map of the site.
  useMap: Schema.optionalKey(Schema.Boolean),
}).check(
  Schema.makeFilter((source) =>
    atsKinds.has(source.kind) && !source.adapterKey
      ? { path: ["adapterKey"], issue: "Enter the board name for this job board" }
      : undefined,
  ),
);
export type UpdateJobSource = typeof UpdateJobSource.Type;

export const StartRun = Schema.Struct({
  sourceIds: Schema.NonEmptyArray(Schema.NonEmptyString),
});
export type StartRun = typeof StartRun.Type;

export const MatchStatus = Schema.Literals(["PENDING", "APPLIED"]);
export type MatchStatus = typeof MatchStatus.Type;

export const MatchesQuery = Schema.Struct({
  status: Schema.optionalKey(MatchStatus),
  // The nextCursor from the previous page.
  cursor: Schema.optionalKey(Schema.NonEmptyString),
});
export type MatchesQuery = typeof MatchesQuery.Type;

export const UpdateMatch = Schema.Struct({ status: MatchStatus });
export type UpdateMatch = typeof UpdateMatch.Type;

export const maxTitleKeywords = 30;
export const maxTitleKeywordLength = 60;

// Words or phrases matched as whole words against job titles.
const TitleKeywords = Schema.Array(
  Schema.Trim.check(
    Schema.makeFilter((keyword) => keyword !== "", { message: "Remove the empty keyword" }),
    Schema.makeFilter((keyword) => keyword.length <= maxTitleKeywordLength, {
      message: `Use at most ${maxTitleKeywordLength} characters per keyword`,
    }),
  ),
).check(
  Schema.makeFilter((keywords) => keywords.length <= maxTitleKeywords, {
    message: `Use at most ${maxTitleKeywords} keywords`,
  }),
);

export const UpdateSettings = Schema.Struct({
  resumeUrl: Schema.NullOr(HttpUrl),
  discordWebhookUrl: Schema.NullOr(DiscordWebhookUrl),
  experienceYears: NonNegativeInt,
  experienceMonths: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: 11 }, { message: "Months must be between 0 and 11" }),
  ),
  targetMinYears: Schema.NullOr(NonNegative),
  targetMaxYears: Schema.NullOr(NonNegative),
  locations: Schema.Array(Schema.String),
  includeUnknown: Schema.Boolean,
  // A title must match one of titleInclude (when there are any) and none of titleExclude.
  titleInclude: TitleKeywords,
  titleExclude: TitleKeywords,
  maxJobsPerRun: Schema.Int.check(
    Schema.isBetween(
      { minimum: 1, maximum: 20 },
      { message: "Jobs per run must be between 1 and 20" },
    ),
  ),
  // Rank job titles against the resume first, and read only the likely fits.
  triageEnabled: Schema.Boolean,
  scheduleMinutes: Schema.NullOr(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(15, { message: "Use 15 minutes or more" })),
  ),
}).check(
  Schema.makeFilter((settings) =>
    settings.targetMinYears !== null &&
    settings.targetMaxYears !== null &&
    settings.targetMinYears > settings.targetMaxYears
      ? { path: ["targetMaxYears"], issue: "Maximum years must be at least the minimum" }
      : undefined,
  ),
);
export type UpdateSettings = typeof UpdateSettings.Type;

export const defaultSettings: UpdateSettings = {
  resumeUrl: null,
  discordWebhookUrl: null,
  experienceYears: 0,
  experienceMonths: 0,
  targetMinYears: null,
  targetMaxYears: null,
  locations: [],
  includeUnknown: true,
  titleInclude: [],
  titleExclude: [],
  maxJobsPerRun: 5,
  triageEnabled: true,
  scheduleMinutes: null,
};

export const RunStatus = Schema.Literals(["QUEUED", "RUNNING", "COMPLETED", "STOPPED", "FAILED"]);
export type RunStatus = typeof RunStatus.Type;

// GET /api/overview: what the home page shows. Dates are ISO 8601 strings, as JSON carries them.
export const Overview = Schema.Struct({
  setup: Schema.Struct({
    hasResume: Schema.Boolean,
    sourceCount: NonNegativeInt,
    // False while no settings have been saved and the defaults are in use.
    hasPreferences: Schema.Boolean,
    hasRun: Schema.Boolean,
  }),
  latestRun: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      status: RunStatus,
      createdAt: Schema.String,
      finishedAt: Schema.NullOr(Schema.String),
      // Jobs the run found to be a match.
      matchCount: NonNegativeInt,
    }),
  ),
  // The QUEUED or RUNNING run, if any.
  activeRun: Schema.NullOr(
    Schema.Struct({ id: Schema.String, status: Schema.Literals(["QUEUED", "RUNNING"]) }),
  ),
  pendingMatches: NonNegativeInt,
  // Null when scheduled checks are off.
  nextScheduledRunAt: Schema.NullOr(Schema.String),
});
export type Overview = typeof Overview.Type;
