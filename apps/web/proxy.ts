import { getSessionCookie } from "better-auth/cookies";
import { type NextRequest, NextResponse } from "next/server";
import { AFTER_SIGN_IN, authHref, safeNext } from "@/lib/safe-next";

// Pages a signed-in visitor skips, and the app's sections, which need a session.
const publicPages = ["/", "/sign-in", "/sign-up"];
const appSections = ["/home", "/analyze", "/matches", "/runs", "/settings", "/welcome"];

function inApp(pathname: string) {
  return appSections.some((section) => pathname === section || pathname.startsWith(`${section}/`));
}

// An optimistic check: only whether a session cookie exists, with no database or API call, so
// pages redirect before they render. The app layout's guard still checks the session itself,
// and clears a cookie that has expired or been revoked.
export function proxy(request: NextRequest) {
  const { pathname, search, searchParams } = request.nextUrl;
  const signedIn = getSessionCookie(request) !== null;

  if (signedIn && publicPages.includes(pathname)) {
    const next = pathname === "/" ? null : safeNext(searchParams.get("next"));
    return NextResponse.redirect(new URL(next ?? AFTER_SIGN_IN, request.url));
  }
  if (!signedIn && inApp(pathname)) {
    return NextResponse.redirect(
      new URL(authHref("/sign-in", `${pathname}${search}`), request.url),
    );
  }
  return NextResponse.next();
}

export const config = {
  // Skips the API, Next's own files, the favicon and anything with a file extension.
  matcher: ["/((?!api/|_next/|favicon\\.ico$|.*\\.[a-zA-Z0-9]+$).*)"],
};
