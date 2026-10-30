import AxeBuilder from "@axe-core/playwright";
import { expect, type Browser, type Page } from "@playwright/test";

export const PASSWORD = "medianz-demo";
export const TOTP = "123456";
export const ACCOUNTS = {
  olivia: "olivia.brown@example.com",
  jack: "jack.wilson@example.com",
  priya: "priya.sharma@example.com",
  lukas: "lukas.becker@example.com",
  rao: "asha.rao@example.com",
  sophie: "sophie.williams@example.com",
  staff: "reception.southbank@example.com",
} as const;

const ref = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const APPT = (n: number) => ref("60000000", n);
export const CLIN = (n: number) => ref("40000000", n);
export const FAC = (n: number) => ref("30000000", n);
export const SOUTHBANK = "Southbank Family Medical";
export const PADDINGTON = "Paddington GP Clinic";

export async function resetMock(page: Page) {
  const res = await page.request.post("/api/mock/reset");
  expect(res.ok()).toBe(true);
}

/** Sign in with the password form; clinicians and staff also enter the TOTP code. */
export async function login(page: Page, email: string, expectPath: RegExp) {
  await page.goto("/login");
  await page.getByLabel("Email").first().fill(email);
  await page.getByRole("textbox", { name: "Password" }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/(mfa|patient|clinician|staff|onboarding)/);
  if (page.url().includes("/mfa")) {
    await page.getByLabel("6-digit code").fill(TOTP);
    await page.getByRole("button", { name: "Verify" }).click();
  }
  await page.waitForURL(expectPath);
}

/** A second signed-in person in their own browser context (own cookies). */
export async function asUser(browser: Browser, email: string, expectPath: RegExp) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, email, expectPath);
  return { context, page };
}

/** Call the mock DataApi as the page's signed-in user (test set-up only). */
export async function mockCall<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  const res = await page.request.post("/api/mock", { data: { method, args } });
  const json = (await res.json()) as { data?: T; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.data as T;
}

export async function chooseClinic(page: Page, name = SOUTHBANK) {
  await page.getByRole("combobox", { name: "Clinic" }).first().selectOption({ label: name });
}

/** Clicks through the booking date strip until a day with times appears, then picks the first time. */
export async function pickFirstSlot(page: Page) {
  const times = page.locator('section[aria-labelledby="slots-title"] ul button');
  for (let week = 0; week < 3; week++) {
    const days = page.locator('ul[aria-label^="Week of"] button:not([disabled])');
    const n = await days.count();
    for (let i = 0; i < n; i++) {
      await days.nth(i).click();
      await page.getByText(/Loading times/).waitFor({ state: "detached" }).catch(() => undefined);
      if (await times.first().isVisible().catch(() => false)) {
        await times.first().click();
        return;
      }
    }
    await page.getByRole("button", { name: "Next week" }).click();
  }
  throw new Error("No bookable time found");
}

/** Zero serious or critical axe violations on the current page. */
export async function expectAccessible(page: Page) {
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`)).toEqual([]);
}

export const localDate = (iso: string, tz = "Australia/Brisbane") =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
