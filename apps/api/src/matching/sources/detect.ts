import type { SourceKind } from "@job-matcher/shared";

export interface DetectedSource {
  readonly kind: SourceKind;
  readonly adapterKey: string | null;
}

const page: DetectedSource = { kind: "PAGE", adapterKey: null };

// Path segments on the ATS hosts that are not boards.
const reservedSegments: ReadonlySet<string> = new Set([
  "api",
  "b",
  "embed",
  "external-referrals",
  "meeting",
]);
const reservedRecruiteeSubdomains: ReadonlySet<string> = new Set([
  "api",
  "app",
  "blog",
  "docs",
  "help",
  "support",
  "www",
]);
const atsDomains = [
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
  "smartrecruiters.com",
  "recruitee.com",
];

// Hosts of the supported ATSs, where a careers page may link its job ads.
export const isAtsHost = (hostname: string) => {
  const host = hostname.toLowerCase();
  return atsDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
};

const validKey = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const keyOf = (value: string | null | undefined) =>
  value && validKey.test(value) && !reservedSegments.has(value.toLowerCase()) ? value : null;

const detectKey = (url: URL): DetectedSource | null => {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const segments = url.pathname.split("/").filter(Boolean);
  const [first, second, third] = segments;

  if (host === "boards-api.greenhouse.io" || host === "boards-api.eu.greenhouse.io") {
    return first === "v1" && second === "boards"
      ? { kind: "GREENHOUSE", adapterKey: keyOf(third) }
      : null;
  }
  if (host.endsWith(".greenhouse.io") && /^(job-)?boards\./.test(host)) {
    // boards.greenhouse.io/embed/job_board?for={token} and its /js script.
    const key = first === "embed" ? url.searchParams.get("for") : first;
    return { kind: "GREENHOUSE", adapterKey: keyOf(key) };
  }
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") {
    return { kind: "LEVER", adapterKey: keyOf(first) };
  }
  if (host === "api.lever.co" || host === "api.eu.lever.co") {
    return first === "v0" && second === "postings"
      ? { kind: "LEVER", adapterKey: keyOf(third) }
      : null;
  }
  if (host === "jobs.ashbyhq.com") return { kind: "ASHBY", adapterKey: keyOf(first) };
  if (host === "api.ashbyhq.com") {
    return first === "posting-api" && second === "job-board"
      ? { kind: "ASHBY", adapterKey: keyOf(third) }
      : null;
  }
  if (host === "jobs.smartrecruiters.com" || host === "careers.smartrecruiters.com") {
    return { kind: "SMARTRECRUITERS", adapterKey: keyOf(first) };
  }
  if (host === "api.smartrecruiters.com") {
    return first === "v1" && second === "companies"
      ? { kind: "SMARTRECRUITERS", adapterKey: keyOf(third) }
      : null;
  }
  const recruitee = /^([a-z0-9-]+)\.recruitee\.com$/.exec(host)?.[1];
  if (recruitee && !reservedRecruiteeSubdomains.has(recruitee)) {
    return { kind: "RECRUITEE", adapterKey: recruitee };
  }
  return null;
};

// Board URLs of the supported ATS hosts; anything else is scraped as a page.
export const detectSource = (url: string): DetectedSource => {
  if (!URL.canParse(url)) return page;
  const detected = detectKey(new URL(url));
  return detected?.adapterKey ? detected : page;
};
