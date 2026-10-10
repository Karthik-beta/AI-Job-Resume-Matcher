import { Data, Effect } from "effect";

export interface Requirements {
  readonly experienceYears: number;
  readonly experienceMonths: number;
  readonly jobMinYears: number | null;
  readonly jobMaxYears: number | null;
  readonly locations: readonly string[];
  readonly includeUnknown: boolean;
}

export interface JobFacts {
  readonly locations: readonly string[];
  readonly experienceMinYears: number | null;
  readonly experienceMaxYears: number | null;
}

export class InvalidRequirements extends Data.TaggedError("InvalidRequirements")<{
  readonly message: string;
}> {}

export const defaultRequirements: Requirements = {
  experienceYears: 0,
  experienceMonths: 0,
  jobMinYears: null,
  jobMaxYears: null,
  locations: [],
  includeUnknown: true,
};

const isWholeCount = (value: number) => Number.isInteger(value) && value >= 0;
const isOptionalYears = (value: number | null) =>
  value === null || (Number.isFinite(value) && value >= 0);

export const makeRequirements = (
  input: Partial<Requirements>,
): Effect.Effect<Requirements, InvalidRequirements> => {
  const requirements: Requirements = { ...defaultRequirements, ...input };
  const { experienceYears, experienceMonths, jobMinYears, jobMaxYears } = requirements;
  if (!isWholeCount(experienceYears)) {
    return Effect.fail(new InvalidRequirements({ message: "Experience years must be 0 or more." }));
  }
  if (!isWholeCount(experienceMonths) || experienceMonths > 11) {
    return Effect.fail(
      new InvalidRequirements({ message: "Experience months must be between 0 and 11." }),
    );
  }
  if (!isOptionalYears(jobMinYears) || !isOptionalYears(jobMaxYears)) {
    return Effect.fail(
      new InvalidRequirements({ message: "Job experience years must be 0 or more." }),
    );
  }
  if (jobMinYears !== null && jobMaxYears !== null && jobMinYears > jobMaxYears) {
    return Effect.fail(
      new InvalidRequirements({
        message: "Minimum job experience must not exceed the maximum.",
      }),
    );
  }
  return Effect.succeed(requirements);
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const mentionsCity = (city: string, location: string) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegExp(city.toLowerCase())}(?![\\p{L}\\p{N}_])`,
    "u",
  ).test(location.toLowerCase());

export const acceptsJob = (requirements: Requirements, job: JobFacts): boolean => {
  if (requirements.locations.length > 0) {
    if (job.locations.length > 0) {
      const matches = requirements.locations.some((city) =>
        job.locations.some((location) => mentionsCity(city, location)),
      );
      if (!matches) return false;
    } else if (!requirements.includeUnknown) {
      return false;
    }
  }

  const userYears = requirements.experienceYears + requirements.experienceMonths / 12;
  if (job.experienceMinYears !== null && job.experienceMinYears > userYears) return false;

  const { jobMinYears, jobMaxYears } = requirements;
  if (jobMinYears !== null || jobMaxYears !== null) {
    if (job.experienceMinYears === null && job.experienceMaxYears === null) {
      return requirements.includeUnknown;
    }
    if (
      jobMaxYears !== null &&
      job.experienceMinYears !== null &&
      job.experienceMinYears > jobMaxYears
    ) {
      return false;
    }
    if (
      jobMinYears !== null &&
      job.experienceMaxYears !== null &&
      job.experienceMaxYears < jobMinYears
    ) {
      return false;
    }
  }
  return true;
};
