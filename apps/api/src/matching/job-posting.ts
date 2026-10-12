import { Schema } from "effect";
import type { Listing } from "./firecrawl";
import { listingPage } from "./sources/adapter";
import { decodeEntities, experienceFromText, htmlToText, isoDate } from "./sources/text";

// What a job page's schema.org JobPosting says, cached with the page.
export const JobPosting = Schema.Struct({
  // The job ad as text.
  description: Schema.NullOr(Schema.String),
  // An ISO timestamp after which the posting is closed.
  validThrough: Schema.NullOr(Schema.String),
  locations: Schema.Array(Schema.String),
  remote: Schema.NullOr(Schema.Boolean),
  experienceMinYears: Schema.NullOr(Schema.Number),
  experienceMaxYears: Schema.NullOr(Schema.Number),
});
export type JobPosting = typeof JobPosting.Type;

// A job ad as read for evaluation: the page's markdown (or the source's ad text), and the
// page's JobPosting data when it has any.
export const JobPage = Schema.Struct({
  markdown: Schema.String,
  posting: Schema.NullOr(JobPosting),
});
export type JobPage = typeof JobPage.Type;

// A page without structured data is cut here before evaluation.
export const maxJobPageChars = 24_000;

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asList = (value: unknown): unknown[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const ldJsonPattern =
  /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;

// Every node of a JSON-LD block: arrays and @graph lists are flattened.
const nodesOf = (value: unknown): JsonRecord[] => {
  if (Array.isArray(value)) return value.flatMap(nodesOf);
  if (!isRecord(value)) return [];
  return [value, ...nodesOf(value["@graph"])];
};

const isJobPosting = (node: JsonRecord) =>
  asList(node["@type"]).some((type) => text(type).replace(/^.*[/:]/, "") === "JobPosting");

const parseBlock = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

// The first JobPosting in the page's JSON-LD blocks; invalid blocks are skipped.
const findJobPosting = (html: string) => {
  for (const [, json = ""] of html.matchAll(ldJsonPattern)) {
    const posting = nodesOf(parseBlock(json.trim())).find(isJobPosting);
    if (posting) return posting;
  }
  return null;
};

const nameOf = (value: unknown) => text(value) || (isRecord(value) ? text(value["name"]) : "");

const addressText = (address: unknown) => {
  if (!isRecord(address)) return text(address);
  return [address["addressLocality"], address["addressRegion"], address["addressCountry"]]
    .map(nameOf)
    .filter((part) => part !== "")
    .join(", ");
};

const locationsOf = (posting: JsonRecord) => {
  const places = asList(posting["jobLocation"]).map((place) =>
    isRecord(place) ? addressText(place["address"]) || nameOf(place) : text(place),
  );
  const applicants = asList(posting["applicantLocationRequirements"]).map(nameOf);
  return [...new Set([...places, ...applicants].filter((location) => location !== ""))];
};

const isRemote = (posting: JsonRecord) =>
  asList(posting["jobLocationType"]).some((type) => text(type).toUpperCase() === "TELECOMMUTE")
    ? true
    : null;

const experienceOf = (posting: JsonRecord) => {
  for (const requirement of asList(posting["experienceRequirements"])) {
    if (isRecord(requirement)) {
      const months = requirement["monthsOfExperience"];
      if (typeof months === "number" && Number.isFinite(months) && months >= 0) {
        return { experienceMinYears: months / 12, experienceMaxYears: null };
      }
    }
    const bounds = experienceFromText(
      isRecord(requirement)
        ? text(requirement["description"]) || text(requirement["name"])
        : text(requirement),
    );
    if (bounds.experienceMinYears !== null) return bounds;
  }
  return { experienceMinYears: null, experienceMaxYears: null };
};

// Some sites escape the ad's HTML once more.
const descriptionOf = (posting: JsonRecord) => {
  const html = text(posting["description"]);
  if (!html) return null;
  return htmlToText(/<[a-z]/i.test(html) ? html : decodeEntities(html)) || null;
};

// A date without a time is valid through the end of that day.
const validThroughOf = (posting: JsonRecord) => {
  const value = text(posting["validThrough"]);
  const iso = isoDate(value);
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return iso;
  return new Date(Date.parse(iso) + 24 * 60 * 60 * 1000 - 1).toISOString();
};

export const parseJobPosting = (html: string): JobPosting | null => {
  const posting = findJobPosting(html);
  if (!posting) return null;
  return {
    description: descriptionOf(posting),
    validThrough: validThroughOf(posting),
    locations: locationsOf(posting),
    remote: isRemote(posting),
    ...experienceOf(posting),
  };
};

export const isExpired = (posting: JobPosting | null, now: number) =>
  posting?.validThrough != null && Date.parse(posting.validThrough) < now;

// The listing with what it was missing filled in from the job page's structured data.
export const withPosting = (listing: Listing, posting: JobPosting | null): Listing => {
  if (!posting) return listing;
  const knowsExperience =
    listing.experienceMinYears !== null || listing.experienceMaxYears !== null;
  return {
    ...listing,
    locations: listing.locations.length > 0 ? listing.locations : posting.locations,
    remote: listing.remote ?? posting.remote,
    ...(knowsExperience
      ? {}
      : {
          experienceMinYears: posting.experienceMinYears,
          experienceMaxYears: posting.experienceMaxYears,
        }),
  };
};

// The posting's own ad when it has one, rather than the whole page.
export const evaluationText = (listing: Listing, { markdown, posting }: JobPage) =>
  posting?.description
    ? listingPage({ ...listing, description: posting.description })
    : markdown.slice(0, maxJobPageChars);
