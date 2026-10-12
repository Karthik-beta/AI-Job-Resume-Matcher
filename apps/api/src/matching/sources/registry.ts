import type { SourceKind } from "@job-matcher/shared";
import { Effect } from "effect";
import { ScrapeFailed } from "../errors";
import type { SourceAdapter } from "./adapter";
import { ashbyAdapter } from "./ashby";
import { greenhouseAdapter } from "./greenhouse";
import { leverAdapter } from "./lever";
import { pageAdapter } from "./page";
import { recruiteeAdapter } from "./recruitee";
import { smartRecruitersAdapter } from "./smartrecruiters";

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
  ASHBY: ashbyAdapter,
  SMARTRECRUITERS: smartRecruitersAdapter,
  RECRUITEE: recruiteeAdapter,
  SEARCH: searchAdapter,
  PAGE: pageAdapter,
};

export const adapterFor = (kind: SourceKind) => adapters[kind];
