// Where a visitor goes after signing in without a `next` page to return to.
export const AFTER_SIGN_IN = "/home";
// Where a new account goes without a `next` page: the setup wizard.
export const AFTER_SIGN_UP = "/welcome";

const authPages = ["/sign-in", "/sign-up"];
// Any origin works: it only tells whether a path would leave the site.
const base = "http://next.invalid";

// Control characters and whitespace. Browsers drop tabs and newlines from URLs, so "/\t/evil.com"
// would be read as "//evil.com".
function hasControlOrSpace(value: string) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function decoded(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

// The `next` page to return to after signing in, or null when it is missing or unsafe. Only a
// path on this site is kept: one starting with a single "/", and never the auth pages themselves.
export function safeNext(next: string | null | undefined): string | null {
  if (!next || next.length > 2048 || hasControlOrSpace(next)) return null;
  if (!next.startsWith("/") || next.includes("\\")) return null;

  let url: URL;
  try {
    url = new URL(next, base);
  } catch {
    return null;
  }
  if (url.origin !== base) return null;

  // "/%2F%2Fevil.com" or "/%5Cevil.com" stay on this site, but are refused like their decoded forms.
  const path = decoded(url.pathname);
  if (path === null || path.startsWith("//") || path.includes("\\") || hasControlOrSpace(path)) {
    return null;
  }
  const page = path.toLowerCase().replace(/\/+$/, "");
  if (authPages.some((auth) => page === auth || page.startsWith(`${auth}/`))) return null;

  return `${url.pathname}${url.search}${url.hash}`;
}

// An auth page's link, keeping a safe `next` page.
export function authHref(page: "/sign-in" | "/sign-up", next: string | null | undefined) {
  const safe = safeNext(next);
  return safe ? `${page}?${new URLSearchParams({ next: safe })}` : page;
}
