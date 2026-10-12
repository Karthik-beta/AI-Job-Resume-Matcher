import { createHash } from "node:crypto";
import type { Requirements } from "./requirements";

export interface MatchContext {
  // sha256 of the resume content, so a new file at the same URL is analysed again.
  readonly resumeHash: string;
  readonly sourceIds: readonly string[];
  readonly model: string;
  readonly requirements: Requirements;
}

const sortedUnique = (values: readonly string[]) => [...new Set(values)].sort();

export const contextKey = ({ resumeHash, sourceIds, model, requirements }: MatchContext) => {
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
  ]);
  return createHash("sha256").update(canonical).digest("hex");
};
