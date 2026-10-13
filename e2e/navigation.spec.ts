import { expect, type Page, test } from "@playwright/test";

const password = "e2e-password-1234";
const sessionCookie = "better-auth.session_token";

// Creates an account through the sign-up page; a new account lands on /home.
async function signUp(page: Page) {
  const email = `e2e-${crypto.randomUUID()}@example.com`;
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("E2E User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL("/home");
  return email;
}

async function signIn(page: Page, email: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

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
  await page.getByRole("button", { name: /^Account menu/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();

  for (const path of ["/home", "/analyze", "/matches", "/settings"]) {
    await page.goto(path);
    await expect(page).toHaveURL(`/sign-in?next=${encodeURIComponent(path)}`);
  }
});

test("a stale session cookie is cleared instead of looping", async ({ page, context }) => {
  await context.addCookies([
    { name: sessionCookie, value: "stale.token", url: "http://localhost:3000" },
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
