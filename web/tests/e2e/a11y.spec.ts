// axe on every main page: zero serious or critical violations.
import { test } from "@playwright/test";
import { ACCOUNTS, APPT, chooseClinic, expectAccessible, login, resetMock } from "./helpers";

test.beforeEach(async ({ page }) => resetMock(page));

test("public pages", async ({ page }) => {
  for (const path of ["/login", "/login?demo", "/signup", "/reset-password", "/privacy"]) {
    await page.goto(path);
    await expectAccessible(page);
  }
});

test("patient pages", async ({ page }) => {
  await login(page, ACCOUNTS.olivia, /\/patient$/);
  for (const path of [
    "/patient",
    "/patient/find",
    "/patient/appointments",
    "/patient/profile",
    `/patient/appointments/${APPT(101)}/live`,
    `/patient/appointments/${APPT(2)}/feedback`,
    "/patient/assistant",
  ]) {
    await page.goto(path);
    await expectAccessible(page);
  }
});

test("clinician pages", async ({ page }) => {
  await login(page, ACCOUNTS.rao, /\/clinician$/);
  for (const path of ["/clinician", "/clinician/review", "/clinician/ratings", "/clinician/leave", `/clinician/appointments/${APPT(2)}`, `/clinician/appointments/${APPT(101)}`]) {
    await page.goto(path);
    await expectAccessible(page);
  }
});

test("staff pages", async ({ page }) => {
  await login(page, ACCOUNTS.staff, /\/staff$/);
  await chooseClinic(page);
  for (const path of [
    "/staff",
    "/staff/book",
    "/staff/patients/new",
    "/staff/schedules",
    "/staff/clinicians",
    "/staff/visits",
    `/staff/visits/${APPT(101)}`,
    "/staff/ratings",
    "/staff/operations",
  ]) {
    await page.goto(path);
    await expectAccessible(page);
  }
});
