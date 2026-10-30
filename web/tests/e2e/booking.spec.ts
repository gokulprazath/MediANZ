import { expect, test } from "@playwright/test";
import { ACCOUNTS, CLIN, FAC, login, pickFirstSlot, resetMock } from "./helpers";

test.beforeEach(async ({ page }) => resetMock(page));

test("patient books, reschedules and cancels", async ({ page }) => {
  await login(page, ACCOUNTS.jack, /\/patient$/);
  await page.goto(`/patient/book/${CLIN(1)}?facility=${FAC(1)}`);
  await pickFirstSlot(page);
  await expect(page.getByText(/holding this time for you/)).toBeVisible();
  await page.getByLabel("Reason for the visit").fill("Sore shoulder");
  await page.getByRole("button", { name: "Book appointment" }).click();
  await expect(page.getByRole("heading", { name: /You're booked in/ })).toBeVisible();

  await page.goto("/patient/appointments");
  const card = page.locator("div[data-slot='card']").filter({ hasText: "Sore shoulder" });
  await expect(card).toBeVisible();
  await card.getByRole("link", { name: "Reschedule" }).click();
  await pickFirstSlot(page);
  await page.getByRole("button", { name: "Move my appointment" }).click();
  await page.waitForURL(/confirmed|appointments/);

  await page.goto("/patient/appointments");
  const moved = page.locator("div[data-slot='card']").filter({ hasText: "Sore shoulder" }).filter({ has: page.getByRole("button", { name: "Cancel" }) });
  await expect(moved).toHaveCount(1);
  await moved.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel appointment" }).click();
  await expect(page.getByText("Appointment cancelled")).toBeVisible();
  await expect(page.locator("div[data-slot='card']").filter({ hasText: "Sore shoulder" }).getByRole("button", { name: "Cancel" })).toHaveCount(0);
});
