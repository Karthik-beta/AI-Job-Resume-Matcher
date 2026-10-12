import { createHash } from "node:crypto";
import type { Requirements } from "./requirements";
import { canonicalTitleFilters, type TitleFilters } from "./title-filters";

export interface MatchContext {
  // sha256 of the resume content, so a new file at the same URL is analysed again.
  readonly resumeHash: string;
  readonly sourceIds: readonly string[];
  readonly model: string;
  readonly requirements: Requirements;
  readonly titleFilters: TitleFilters;
}

const sortedUnique = (values: readonly string[]) => [...new Set(values)].sort();

export const contextKey = ({
  resumeHash,
  sourceIds,
  model,
  requirements,
  titleFilters,
}: MatchContext) => {
  const { include, exclude } = canonicalTitleFilters(titleFilters);
  const canonical = JSON.stringify([
    resumeHash,
    sortedUnique(sourceIds),
    model,
    [
      requirements.experienceYears,
      requirements.experienceMonths,
      requirements.jobMinYears,
      requirements.jobMaxYears,
      sortedUnique(requirements.locations),
      requirements.includeUnknown,
    ],
    // Left out when unused, so keys from before title filters existed still match.
    ...(include.length > 0 || exclude.length > 0 ? [[include, exclude]] : []),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
};
