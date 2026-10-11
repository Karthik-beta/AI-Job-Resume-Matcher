// Tests must use the fake providers; any request to a real one fails loudly.
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
