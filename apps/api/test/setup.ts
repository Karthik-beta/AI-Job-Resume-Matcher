// Tests must use the fake providers. Without keys no live layer can be built, which also
// covers the Firecrawl SDK (it uses axios, not fetch); any fetch to a provider fails loudly.
delete process.env["FIRECRAWL_API_KEY"];
delete process.env["OPENROUTER_API_KEY"];
// The fake Firecrawl follows FIRECRAWL_MODE; tests pick a mode explicitly where it matters.
delete process.env["FIRECRAWL_MODE"];
process.env["PROVIDERS"] = "fake";

// The ATS hosts serve the public job board APIs the source adapters read.
const blockedHosts = [
  "firecrawl.dev",
  "openrouter.ai",
  "discord.com",
  "discordapp.com",
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
  "smartrecruiters.com",
  "recruitee.com",
];
const realFetch = globalThis.fetch;

const isBlocked = (input: string | URL | Request) => {
  const raw = input instanceof Request ? input.url : String(input);
  if (!URL.canParse(raw)) return false;
  const hostname = new URL(raw).hostname.replace(/\.$/, "");
  return blockedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
};

globalThis.fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) =>
    isBlocked(input)
      ? Promise.reject(new Error(`Tests must not call ${String(input)}`))
      : realFetch(input, init),
  realFetch,
);
