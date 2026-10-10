import { createHash } from "node:crypto";
import type { Requirements } from "./requirements";

export interface MatchContext {
  readonly resumeUrl: string;
  readonly sourceIds: readonly string[];
  readonly model: string;
  readonly requirements: Requirements;
}

const sortedUnique = (values: readonly string[]) => [...new Set(values)].sort();

export const contextKey = ({ resumeUrl, sourceIds, model, requirements }: MatchContext) => {
  const canonical = JSON.stringify([
    resumeUrl,
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
