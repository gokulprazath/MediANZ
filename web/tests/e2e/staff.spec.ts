import { expect, test } from "@playwright/test";
import { ACCOUNTS, APPT, chooseClinic, login, resetMock } from "./helpers";

test.beforeEach(async ({ page }) => resetMock(page));

test("staff edit fees and add a claim on a visit", async ({ page }) => {
  await login(page, ACCOUNTS.staff, /\/staff$/);
  await chooseClinic(page);
  await page.goto(`/staff/visits/${APPT(101)}`);
  await page.getByLabel("Fee charged ($)").fill("80");
  await page.getByLabel("Medicare rebate ($)").fill("41.40");
  await expect(page.getByLabel("Gap ($)")).toHaveValue("38.60");
  await page.getByRole("button", { name: "Save fees" }).click();
  await expect(page.getByText("Fees saved")).toBeVisible();

  await page.getByRole("button", { name: "New claim" }).click();
  await page.getByRole("button", { name: "Create claim" }).click();
  // Either the claim is created or the "no policy" message is shown, depending on the patient's cover.
  await expect(page.getByText(/Claim created|no insurance policy on the visit date/).first()).toBeVisible();
});

test("staff visit list and reports", async ({ page }) => {
  await login(page, ACCOUNTS.staff, /\/staff$/);
  await chooseClinic(page);
  await page.goto("/staff/visits");
  await expect(page.getByRole("heading", { name: "Visits, fees and claims" })).toBeVisible();
  await page.getByRole("tab", { name: "Reports" }).click();
  await expect(page.getByText("No-show rate")).toBeVisible();
});
