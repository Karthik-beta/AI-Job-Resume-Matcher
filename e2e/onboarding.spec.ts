import { expect, type Page, test } from "@playwright/test";
import { addResume, signUp } from "./support";

// Next keeps pages visited earlier in the DOM, hidden, so the wizard's "Get set up" title may
// still be there.
const checklist = (page: Page) =>
  page.getByText("Get set up", { exact: true }).filter({ visible: true });

async function finishLater(page: Page) {
  await page.getByRole("link", { name: "Finish later" }).click();
  await expect(page).toHaveURL("/home");
}

test("leaving the wizard keeps progress, and Continue setup resumes where it stopped", async ({
  page,
}) => {
  await signUp(page);
  await addResume(page);
  await finishLater(page);

  await expect(checklist(page)).toBeVisible();
  await expect(page.getByText("1 of 3 required done")).toBeVisible();

  // Matching is optional, but the wizard still offers it, in order, after the resume.
  await page.getByRole("link", { name: "Continue setup" }).click();
  await expect(page).toHaveURL("/welcome?step=preferences");
  await expect(page.getByRole("heading", { name: "Matching basics" })).toBeVisible();

  // Once matching is saved, setup picks up at the job sources.
  await page.getByLabel("Cities", { exact: true }).fill("Remote");
  await page.getByRole("button", { name: "Save matching" }).click();
  await expect(page).toHaveURL("/welcome?step=source");
  await finishLater(page);
  await expect(page.getByText("1 of 3 required done")).toBeVisible();

  await page.getByRole("link", { name: "Continue setup" }).click();
  await expect(page).toHaveURL("/welcome?step=source");
  await expect(page.getByRole("heading", { name: "Add a job source" })).toBeVisible();
});

test("the checklist can be hidden, and Setup guide brings it back", async ({ page }) => {
  await signUp(page);
  await page.getByRole("link", { name: "Skip for now" }).click();
  await expect(page).toHaveURL("/home");
  await expect(checklist(page)).toBeVisible();
  await expect(page.getByText("0 of 3 required done")).toBeVisible();

  await page.getByRole("button", { name: "Hide checklist" }).click();
  await expect(checklist(page)).toBeHidden();
  await expect(page.getByText("Finish setting up")).toBeVisible();
  // Hiding is saved, not just for this visit.
  await page.reload();
  await expect(page.getByText("Finish setting up")).toBeVisible();
  await expect(checklist(page)).toBeHidden();

  await page.getByRole("button", { name: /^Account menu/ }).click();
  await page.getByRole("menuitem", { name: "Setup guide" }).click();
  await expect(page).toHaveURL("/home");
  await expect(checklist(page)).toBeVisible();
  await page.reload();
  await expect(checklist(page)).toBeVisible();
});
