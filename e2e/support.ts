import { expect, type Page } from "@playwright/test";

// Shared by the specs. With fake providers this source lists the fixture jobs, and with no
// experience set only the listing without an experience range passes the filters.
export const password = "e2e-password-1234";
export const sourceUrl = "https://board.example.com/jobs";
export const matchTitle = "Full Stack Developer";

// Creates an account through the sign-up page; a new account lands on the setup wizard.
export async function signUp(page: Page) {
  const email = `e2e-${crypto.randomUUID()}@example.com`;
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("E2E User");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  // The wizard adds the step it opens on to the URL.
  await expect(page).toHaveURL(/^[^?]*\/welcome(\?step=welcome)?$/);
  await expect(page.getByRole("heading", { name: "How it works" })).toBeVisible();
  return email;
}

export async function signIn(page: Page, email: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

export async function signOut(page: Page) {
  await page.getByRole("button", { name: /^Account menu/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/");
}

// From the wizard's first step, saves a resume, which moves on to the matching step.
export async function addResume(page: Page) {
  await page.getByRole("button", { name: "Let's set up" }).click();
  await expect(page).toHaveURL("/welcome?step=resume");
  await expect(page.getByRole("heading", { name: "Add your resume" })).toBeVisible();
  await page.getByLabel("Resume URL").fill("https://example.com/cv.pdf");
  await page.getByRole("button", { name: "Save resume" }).click();
  await expect(page).toHaveURL("/welcome?step=preferences");
  await expect(page.getByRole("heading", { name: "Matching basics" })).toBeVisible();
}

// Walks the whole wizard and starts the first run, which opens with the run guide.
export async function completeSetup(page: Page) {
  await addResume(page);
  await page.getByRole("button", { name: "Use defaults" }).click();

  await expect(page).toHaveURL("/welcome?step=source");
  await expect(page.getByRole("heading", { name: "Add a job source" })).toBeVisible();
  await page.getByLabel("Careers page URL").fill(sourceUrl);
  await page.getByRole("button", { name: "Add source" }).click();
  await expect(page.getByText(sourceUrl)).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();

  await expect(page).toHaveURL("/welcome?step=firstRun");
  await expect(page.getByRole("heading", { name: "Start your first run" })).toBeVisible();
  await page.getByRole("button", { name: "Start first run" }).click();
  await expect(page).toHaveURL(/\/runs\/[^/?]+\?first=1$/);
  await expect(page.getByRole("region", { name: "What happens during a run" })).toBeVisible();
}
