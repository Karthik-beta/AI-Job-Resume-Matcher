import { expect, test } from "@playwright/test";

test("sign up, analyse a source and mark the match as applied", async ({ page }) => {
  await page.goto("/sign-up");
  await page.getByLabel("Name").fill("E2E User");
  await page.getByLabel("Email").fill(`e2e-${crypto.randomUUID()}@example.com`);
  await page.getByLabel("Password").fill("e2e-password-1234");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL("/");

  await page.goto("/settings");
  await page.getByLabel("Careers page URL").fill("https://board.example.com/jobs");
  await page.getByRole("button", { name: "Add source" }).click();
  await expect(page.getByText("https://board.example.com/jobs")).toBeVisible();

  await page.getByLabel("Resume URL").fill("https://example.com/cv.pdf");
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByText("Preferences saved")).toBeVisible();

  // With no experience set, only the listing without an experience range passes the filters.
  await page.goto("/analyze");
  await page.getByRole("button", { name: "Analyze" }).click();
  await expect(page.getByText("Completed")).toBeVisible();
  await expect(page.getByText("Full Stack Developer")).toBeVisible();
  await expect(page.getByText("Match", { exact: true })).toBeVisible();

  await page.goto("/matches");
  await expect(page.getByText("Full Stack Developer")).toBeVisible();
  await page.getByRole("button", { name: "Mark applied" }).click();
  await expect(page.getByText("No pending matches.", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Applied" }).click();
  await expect(page.getByText("Full Stack Developer")).toBeVisible();
  await expect(page.getByRole("button", { name: "Move to pending" })).toBeVisible();
});
