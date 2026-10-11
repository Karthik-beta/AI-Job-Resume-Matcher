// Tests must use the fake providers. Without keys no live layer can be built, which also
// covers the Firecrawl SDK (it uses axios, not fetch); any fetch to a provider fails loudly.
delete process.env["FIRECRAWL_API_KEY"];
delete process.env["OPENROUTER_API_KEY"];
process.env["PROVIDERS"] = "fake";

const blockedHosts = ["firecrawl.dev", "openrouter.ai", "discord.com", "discordapp.com"];
const realFetch = globalThis.fetch;

const isBlocked = (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : input);
  return blockedHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
};

globalThis.fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) =>
    isBlocked(input)
      ? Promise.reject(new Error(`Tests must not call ${String(input)}`))
      : realFetch(input, init),
  realFetch,
);
