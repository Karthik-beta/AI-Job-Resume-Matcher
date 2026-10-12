import type { Settings } from "../generated/prisma/client";
import type { Requirements } from "../matching/requirements";
import type { TitleFilters } from "../matching/title-filters";

export const requirementsOf = (settings: Settings): Requirements => ({
  experienceYears: settings.experienceYears,
  experienceMonths: settings.experienceMonths,
  jobMinYears: settings.targetMinYears,
  jobMaxYears: settings.targetMaxYears,
  locations: settings.locations,
  includeUnknown: settings.includeUnknown,
});

export const titleFiltersOf = (settings: Settings): TitleFilters => ({
  include: settings.titleInclude,
  exclude: settings.titleExclude,
});
