import type { Listing } from "./firecrawl";

// Tracking parameters that name where a visitor came from, not which job they see.
const trackingParams: ReadonlySet<string> = new Set(["ref", "source", "gh_src"]);

const isTrackingParam = (name: string) => {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || trackingParams.has(lower);
};

// One spelling per job page: a lowercase host, no tracking parameters, no fragment and no
// trailing slash (except the root). Text that is not a URL is kept as it is.
export const canonicalUrl = (url: string) => {
  if (!URL.canParse(url)) return url;
  const parsed = new URL(url);
  parsed.hash = "";
  for (const name of [...parsed.searchParams.keys()]) {
    if (isTrackingParam(name)) parsed.searchParams.delete(name);
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString();
};

// Lowercase words without punctuation, so "Engineer, Backend" and "engineer - backend" agree.
export const normaliseText = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const jobKey = ({ company, title, locations }: Listing) =>
  JSON.stringify([
    normaliseText(company),
    normaliseText(title),
    locations.map((location) => location.trim().toLowerCase()).sort(),
  ]);

// The same job listed by several sources, or twice by one, is kept once: listings with the
// same canonical URL, or the same company, title and locations, keep the first (in source
// order). Kept listings carry their canonical URL.
export const dedupeListings = (listings: readonly Listing[]) => {
  const urls = new Set<string>();
  const keys = new Set<string>();
  const kept: Listing[] = [];
  for (const listing of listings) {
    const url = canonicalUrl(listing.url);
    const key = jobKey(listing);
    if (urls.has(url) || keys.has(key)) continue;
    urls.add(url);
    keys.add(key);
    kept.push({ ...listing, url });
  }
  return kept;
};
