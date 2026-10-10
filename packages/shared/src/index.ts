import { Schema } from "effect";

const isHttpUrl = (value: string) => {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === "http:" || protocol === "https:";
};

export const HttpUrl = Schema.Trimmed.check(
  Schema.makeFilter(isHttpUrl, { message: "Enter a valid http or https URL" }),
);

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

export const CreateJobSource = Schema.Struct({ url: HttpUrl });
export type CreateJobSource = typeof CreateJobSource.Type;

export const StartRun = Schema.Struct({
  sourceIds: Schema.NonEmptyArray(Schema.NonEmptyString),
});
export type StartRun = typeof StartRun.Type;

export const UpdateSettings = Schema.Struct({
  resumeUrl: Schema.NullOr(HttpUrl),
  discordWebhookUrl: Schema.NullOr(HttpUrl),
  experienceYears: NonNegativeInt,
  experienceMonths: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: 11 }, { message: "Months must be between 0 and 11" }),
  ),
  targetMinYears: Schema.NullOr(NonNegative),
  targetMaxYears: Schema.NullOr(NonNegative),
  locations: Schema.Array(Schema.String),
  includeUnknown: Schema.Boolean,
  maxJobsPerRun: Schema.Int.check(
    Schema.isBetween(
      { minimum: 1, maximum: 20 },
      { message: "Jobs per run must be between 1 and 20" },
    ),
  ),
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
  maxJobsPerRun: 5,
  scheduleMinutes: null,
};
