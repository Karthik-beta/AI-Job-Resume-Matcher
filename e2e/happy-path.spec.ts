import { expect, test } from "@playwright/test";
import { completeSetup, matchTitle, signUp } from "./support";

test("sign up, set up through the wizard and mark the first match as applied", async ({ page }) => {
  await signUp(page);
  // Resume, the default matching settings, a source, then the first run.
  await completeSetup(page);

  await expect(page.getByText("Completed", { exact: true })).toBeVisible();
  await expect(page.getByText(matchTitle)).toBeVisible();
  await expect(page.getByText("Match", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "See your matches" }).click();

  // Next keeps the run page in the DOM, hidden, with the same job title on it, so only the
  // visible title counts.
  const visibleMatch = page.getByText(matchTitle).filter({ visible: true });
  await expect(page).toHaveURL("/matches");
  await expect(visibleMatch).toBeVisible();
  await page.getByRole("button", { name: "Mark applied" }).click();
  await expect(page.getByText("No pending matches.", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Applied" }).click();
  await expect(visibleMatch).toBeVisible();
  await expect(page.getByRole("button", { name: "Move to pending" })).toBeVisible();
});
