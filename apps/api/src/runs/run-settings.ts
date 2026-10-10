import type { Settings } from "../generated/prisma/client";
import type { Requirements } from "../matching/requirements";

export const requirementsOf = (settings: Settings): Requirements => ({
  experienceYears: settings.experienceYears,
  experienceMonths: settings.experienceMonths,
  jobMinYears: settings.targetMinYears,
  jobMaxYears: settings.targetMaxYears,
  locations: settings.locations,
  includeUnknown: settings.includeUnknown,
});
