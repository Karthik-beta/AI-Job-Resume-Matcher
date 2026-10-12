import type { SourceKind } from "@job-matcher/shared";
import type { SourceAdapter } from "./adapter";
import { ashbyAdapter } from "./ashby";
import { greenhouseAdapter } from "./greenhouse";
import { leverAdapter } from "./lever";
import { pageAdapter } from "./page";
import { recruiteeAdapter } from "./recruitee";
import { searchAdapter } from "./search";
import { smartRecruitersAdapter } from "./smartrecruiters";

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

// How the ad of a listing without one is read: the source's API when it can read this URL,
// otherwise null, and the page is scraped.
export const descriptionReader = (kind: SourceKind, url: string) => {
  const { fetchDescription, describes } = adapterFor(kind);
  return fetchDescription && (describes?.(url) ?? true) ? fetchDescription : null;
};
