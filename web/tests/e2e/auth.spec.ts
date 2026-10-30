import { expect, test } from "@playwright/test";
import { ACCOUNTS, login, resetMock } from "./helpers";

test.beforeEach(async ({ page }) => resetMock(page));

test("patient signs in to the patient portal", async ({ page }) => {
  await login(page, ACCOUNTS.olivia, /\/patient$/);
  await expect(page.getByRole("link", { name: "My appointments" })).toBeVisible();
});

test("clinician signs in with an MFA code", async ({ page }) => {
  await login(page, ACCOUNTS.rao, /\/clinician$/);
  await expect(page.getByRole("heading", { name: "My calendar" })).toBeVisible();
});

test("staff sign in with an MFA code", async ({ page }) => {
  await login(page, ACCOUNTS.staff, /\/staff$/);
  await expect(page.getByRole("combobox", { name: "Clinic" }).first()).toBeVisible();
});

for (const [role, home, check] of [
  ["Patient", /\/patient$/, "My appointments"],
  ["Clinician", /\/clinician$/, "Review queue"],
  ["Receptionist", /\/staff$/, "AI operations"],
] as const) {
  test(`evaluators sign in with the ${role.toLowerCase()} demo account`, async ({ page }) => {
    await page.goto("/login?demo");
    await expect(page.getByRole("tab", { name: "Demo account" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: `Continue as ${role}` }).click();
    await page.waitForURL(home);
    await expect(page.getByRole("link", { name: new RegExp(check) }).first()).toBeVisible();
  });
}

test("a wrong password is refused", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").first().fill(ACCOUNTS.olivia);
  await page.getByRole("textbox", { name: "Password" }).fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("tabpanel").getByRole("alert")).toContainText("Email or password is incorrect");
});

test("portals are protected", async ({ page }) => {
  await page.goto("/staff");
  await expect(page).toHaveURL(/\/login/);
  await login(page, ACCOUNTS.olivia, /\/patient$/);
  await page.goto("/staff");
  await expect(page).not.toHaveURL(/\/staff/);
});
