import type { SourceKind } from "@job-matcher/shared";
import { Effect } from "effect";
import { ScrapeFailed } from "../errors";
import type { SourceAdapter } from "./adapter";
import { greenhouseAdapter } from "./greenhouse";
import { leverAdapter } from "./lever";
import { pageAdapter } from "./page";

// Search sources arrive with AJM-92; until then a stray one fails instead of being scraped.
const searchAdapter: SourceAdapter = {
  fetchListings: () =>
    Effect.fail(
      new ScrapeFailed({ status: null, message: "Search sources are not supported yet." }),
    ),
};

const adapters: Record<SourceKind, SourceAdapter> = {
  GREENHOUSE: greenhouseAdapter,
  LEVER: leverAdapter,
  ASHBY: pageAdapter,
  SMARTRECRUITERS: pageAdapter,
  RECRUITEE: pageAdapter,
  SEARCH: searchAdapter,
  PAGE: pageAdapter,
};

export const adapterFor = (kind: SourceKind) => adapters[kind];
