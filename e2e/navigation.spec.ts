import { expect, test } from "@playwright/test";
import { completeSetup, password, signIn, signOut, signUp } from "./support";

const sessionCookie = "better-auth.session_token";

test("a signed-in visitor skips the landing and auth pages", async ({ page }) => {
  await signUp(page);
  for (const path of ["/", "/sign-in", "/sign-up"]) {
    await page.goto(path);
    await expect(page).toHaveURL("/home");
  }
  await page.goto("/sign-in?next=%2Fsettings");
  await expect(page).toHaveURL("/settings");
});

test("a signed-out visitor returns to the page they asked for after signing in", async ({
  page,
  context,
}) => {
  const email = await signUp(page);
  await context.clearCookies();

  await page.goto("/settings");
  await expect(page).toHaveURL("/sign-in?next=%2Fsettings");
  // The switch link carries the page across.
  await expect(page.getByRole("link", { name: "Create an account" })).toHaveAttribute(
    "href",
    "/sign-up?next=%2Fsettings",
  );
  await signIn(page, email);
  await expect(page).toHaveURL("/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();

  // The sign-in page was replaced, so Back doesn't return to the form.
  await page.goBack();
  await expect(page).not.toHaveURL(/\/sign-in/);
});

for (const next of ["//evil.com", "https://evil.com"]) {
  test(`an unsafe next page (${next}) falls back to /home`, async ({ page, context }) => {
    const email = await signUp(page);
    await context.clearCookies();

    await page.goto(`/sign-in?next=${encodeURIComponent(next)}`);
    await signIn(page, email);
    await expect(page).toHaveURL("/home");
  });
}

test("signing out returns to the landing page and protects the app again", async ({ page }) => {
  await signUp(page);
  await signOut(page);
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();

  for (const path of ["/home", "/welcome", "/analyze", "/matches", "/settings"]) {
    await page.goto(path);
    await expect(page).toHaveURL(`/sign-in?next=${encodeURIComponent(path)}`);
  }
});

test("a returning user who finished setup signs in to /home, never the wizard", async ({
  page,
}) => {
  const email = await signUp(page);
  await completeSetup(page);
  await expect(page.getByText("Completed", { exact: true })).toBeVisible();
  await signOut(page);

  const visited: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname);
  });
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/sign-in");
  await signIn(page, email);
  await expect(page).toHaveURL("/home");
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
  // Next keeps the wizard's page in the DOM, hidden, so only a visible checklist counts.
  await expect(
    page.getByText("Get set up", { exact: true }).filter({ visible: true }),
  ).toBeHidden();
  expect(visited).not.toContain("/welcome");

  // Setup is done, so the menu no longer offers the guide and the wizard sends them home.
  await page.getByRole("button", { name: /^Account menu/ }).click();
  await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Setup guide" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.goto("/welcome?step=resume");
  await expect(page).toHaveURL("/home");
  await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible();
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the navigation menu opens and navigates", async ({ page }) => {
    await signUp(page);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();

    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("menuitem", { name: "Matches" }).click();
    await expect(page).toHaveURL("/matches");
    await expect(page.getByRole("heading", { name: "Matches", level: 1 })).toBeVisible();

    // The menu marks the current page.
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.getByRole("menuitem", { name: "Matches" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await page.getByRole("menuitem", { name: "Settings" }).click();
    await expect(page).toHaveURL("/settings");
    await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  });
});

test("a stale session cookie is cleared instead of looping", async ({ page, context, baseURL }) => {
  await context.addCookies([
    { name: sessionCookie, value: "stale.token", url: baseURL ?? "http://localhost:3000" },
  ]);

  // A loop would keep bouncing between /home and the sign-in page, so once the page settles
  // no further navigations may happen.
  let navigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });

  // The proxy trusts the cookie and sends `/` to /home; the app finds no session, clears the
  // cookie and settles on the sign-in page.
  await page.goto("/");
  await expect(page).toHaveURL("/sign-in?next=%2Fhome");
  await expect
    .poll(async () => (await context.cookies()).some(({ name }) => name === sessionCookie))
    .toBe(false);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await page.waitForLoadState("networkidle");
  const settled = navigations;
  await page.waitForTimeout(500);
  expect(navigations).toBe(settled);
  await expect(page).toHaveURL("/sign-in?next=%2Fhome");

  // With the cookie gone the proxy no longer redirects, so a reload stays put.
  await page.reload();
  await expect(page).toHaveURL("/sign-in?next=%2Fhome");
});

test("switching accounts in another tab resets the open pages", async ({ page, context }) => {
  await signUp(page);
  await page.goto("/settings");
  const resumeUrl = page.getByLabel("Resume URL");
  await resumeUrl.fill("https://example.com/first-user.pdf");
  await page.getByRole("button", { name: "Save resume" }).click();
  await expect(page.getByText("Resume saved")).toBeVisible();

  // Another tab signs in as someone else. The shared cookie changes, but this tab is never told
  // the first user signed out.
  const response = await context.request.post("/api/auth/sign-up/email", {
    headers: { origin: new URL(page.url()).origin },
    data: { name: "Second User", email: `e2e-${crypto.randomUUID()}@example.com`, password },
  });
  expect(response.ok()).toBe(true);

  // Coming back to the tab checks the session again (at most every 5 seconds).
  await expect(async () => {
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.getByRole("button", { name: "Account menu for Second User" })).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 15_000 });
  await expect(resumeUrl).toHaveValue("");
});
