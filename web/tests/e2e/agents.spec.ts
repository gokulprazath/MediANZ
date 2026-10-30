// Part B agent features in mock mode (offline stand-ins for the agent service
// and discovery API, same contracts): patient assistant -> GP question ->
// clinician review queue -> answer; AI care finder booking; AI operations.
import { expect, test } from "@playwright/test";
import { ACCOUNTS, asUser, login, resetMock } from "./helpers";

test.beforeEach(async ({ page }) => resetMock(page));

test("assistant drafts a GP question; clinician approves the AI facts and answers", async ({ page, browser }) => {
  await login(page, ACCOUNTS.olivia, /\/patient$/);
  await page.goto("/patient/assistant");
  await expect(page.getByText("AI assistant, not a clinician")).toBeVisible();
  await page.getByRole("button", { name: "What medication did my GP start?" }).click();
  await expect(page.getByText("Records agent").first()).toBeVisible();
  await expect(page.getByText("Send this question to your clinician?")).toBeVisible();
  await expect(page.locator("blockquote").filter({ hasText: "What medication did my GP start?" })).toBeVisible();
  await page.getByRole("button", { name: "Approve and send" }).click();
  await expect(page.getByText("Question sent to your clinician")).toBeVisible();
  const mine = page.getByRole("region").or(page.locator("[aria-labelledby='my-questions']"));
  await expect(mine.getByText("What medication did my GP start?").first()).toBeVisible();

  // Dr Rao: the queue has the AI drafts from Olivia's approved transcript.
  const rao = await asUser(browser, ACCOUNTS.rao, /\/clinician$/);
  const c = rao.page;
  await expect(c.getByRole("link", { name: /Review queue \(\d+\)/ })).toBeVisible();
  await c.getByRole("link", { name: /Review queue/ }).click();
  await expect(c.getByRole("heading", { name: /Patient questions/ })).toBeVisible();
  const fact = c.locator("li").filter({ hasText: "Current medication" }).first();
  await fact.getByRole("button", { name: "Show transcript evidence" }).click();
  await expect(fact.getByText(/iron supplement once a day/i)).toBeVisible();
  await fact.getByRole("button", { name: "Approve" }).click();
  await expect(c.getByText("Fact approved")).toBeVisible();
  const question = c.locator("li").filter({ hasText: "What medication did my GP start?" });
  await question.getByLabel("Your answer").fill("An iron supplement once a day, with some vitamin C.");
  await question.getByRole("button", { name: "Send answer" }).click();
  await expect(c.getByText("Answer sent")).toBeVisible();

  // Olivia sees the answer, and the records agent now answers from the approved fact.
  await page.reload();
  await expect(page.getByText("An iron supplement once a day, with some vitamin C.")).toBeVisible();
  await page.getByLabel("Your question").fill("What medication did my GP start?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText(/Current medication: Iron supplement/)).toBeVisible();
  await rao.context.close();
});

test("AI care finder ranks clinics with cost and books after confirmation", async ({ page }) => {
  await login(page, ACCOUNTS.jack, /\/patient$/);
  await page.goto("/patient/concierge");
  await page.getByLabel("What do you need help with?").fill("My back has been sore for a week");
  await page.getByLabel("Or suburb / postcode").fill("4101");
  await page.getByRole("button", { name: "Set" }).click();
  await expect(page.getByText(/Showing distances from/)).toBeVisible();
  await page.getByRole("button", { name: "Find care" }).click();
  await expect(page.getByRole("heading", { name: /Best matches for standard gp consultation/i })).toBeVisible();
  await expect(page.getByText("AI summary:").first()).toBeVisible();
  await expect(page.getByText("You pay (estimate)").first()).toBeVisible();
  await page.getByText("Why this clinic?").first().click();
  await expect(page.getByText("How soon").first()).toBeVisible();
  await page.getByRole("button", { name: /^Book / }).first().click();
  await expect(page.getByRole("heading", { name: "Confirm your booking" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("heading", { name: /You're booked in/ })).toBeVisible();
});

test("care finder asks which service when the problem is unclear", async ({ page }) => {
  await login(page, ACCOUNTS.jack, /\/patient$/);
  await page.goto("/patient/concierge");
  await page.getByLabel("What do you need help with?").fill("not sure");
  await page.getByLabel("Distance (km)").fill("25"); // the dermatologist is in Chermside, about 10 km away
  await page.getByLabel("Or suburb / postcode").fill("4101");
  await page.getByRole("button", { name: "Set" }).click();
  await page.getByRole("button", { name: "Find care" }).click();
  await expect(page.getByRole("heading", { name: "Which of these do you need?" })).toBeVisible();
  await page.getByRole("button", { name: "Skin check" }).click();
  await expect(page.getByRole("heading", { name: /skin check/i })).toBeVisible();
});

test("staff see AI operations and approve a research draft", async ({ page }) => {
  await login(page, ACCOUNTS.staff, /\/staff$/);
  await page.goto("/staff/operations");
  await page.getByLabel("Period").selectOption("720");
  await expect(page.getByRole("heading", { name: "Agent fleet activity" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "patient-concierge" }).first()).toBeVisible();
  await expect(page.getByText("May receive health data").first()).toBeVisible();
  await page.getByRole("region", { name: "Insurance research drafts" }).getByRole("button", { name: "Approve" }).first().click();
  await expect(page.getByText(/Draft approved/)).toBeVisible();
});
