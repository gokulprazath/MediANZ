// Front desk check-in, consent from both sides, recording on the clinician's
// device, transcript review by the patient, completion and feedback.
import { expect, test } from "@playwright/test";
import { ACCOUNTS, APPT, asUser, chooseClinic, localDate, login, mockCall, PADDINGTON, resetMock } from "./helpers";

test.beforeEach(async ({ page }) => resetMock(page));

test("front desk checks in; consent, recording, transcript review and feedback", async ({ page, browser }) => {
  const id = APPT(103); // Priya with Dr Williams at Paddington (seed), no consent yet

  // Staff: front desk for that day, check the patient in.
  await login(page, ACCOUNTS.staff, /\/staff$/);
  const appt = await mockCall<{ scheduled_start: string }>(page, "getAppointment", id);
  await chooseClinic(page, PADDINGTON);
  await page.getByLabel("Day").fill(localDate(appt.scheduled_start));
  const row = page.locator("li").filter({ hasText: "Priya" }).filter({ has: page.getByRole("button", { name: "Check in" }) });
  await row.getByRole("button", { name: "Check in" }).click();
  await expect(page.getByText(/checked in/).first()).toBeVisible();

  // Patient: appointment day page, consent.
  const patient = await asUser(browser, ACCOUNTS.priya, /\/patient$/);
  await patient.page.goto(`/patient/appointments/${id}/live`);
  await expect(patient.page.getByText(/You're checked in/)).toBeVisible();
  await expect(patient.page.getByText("Audio is not stored")).toBeVisible();
  await patient.page.getByRole("button", { name: "I agree to recording" }).click();
  await expect(patient.page.getByText(/Waiting for your clinician to agree/)).toBeVisible();

  // Clinician: consult view, consent, start consultation, record.
  const clinician = await asUser(browser, ACCOUNTS.sophie, /\/clinician$/);
  const c = clinician.page;
  await c.goto(`/clinician/appointments/${id}`);
  await c.getByRole("button", { name: "Start consultation" }).click();
  await expect(c.getByText("In consultation").first()).toBeVisible();
  await c.getByRole("button", { name: "I agree to recording" }).click();
  await c.getByRole("button", { name: "Start recording" }).click();
  await expect(c.getByRole("status").filter({ hasText: /^Recording$/ })).toBeVisible();

  // The patient sees the recording is on the clinician's device.
  await expect(patient.page.getByText("Recording on the clinician's device")).toBeVisible({ timeout: 20_000 });

  await c.waitForTimeout(1500);
  await c.getByRole("button", { name: "Stop and transcribe" }).click();
  await expect(c.getByText(/Transcript drafted/)).toBeVisible();

  // Vitals with BMI preview.
  await c.getByLabel("Height (cm)").fill("170");
  await c.getByLabel("Weight (kg)").fill("70");
  await expect(c.getByText("BMI:")).toContainText("24.2");
  await c.getByRole("button", { name: "Record vitals" }).click();
  await expect(c.getByText("Vitals recorded")).toBeVisible();

  // Patient reviews and approves the draft.
  const p = patient.page;
  await p.goto("/patient/profile#recordings");
  await p.getByRole("link", { name: "Review draft" }).click();
  await expect(p.getByRole("heading", { name: "Review your transcript" })).toBeVisible();
  await expect(p.getByText(/Speaker 1/).first()).toBeVisible();
  await p.getByRole("button", { name: "Approve" }).click();
  await expect(p.getByText("Transcript approved")).toBeVisible();

  // Clinician now sees the approved transcript, and completes the visit.
  await c.reload();
  await expect(c.getByText(/^Transcript, /)).toBeVisible();
  await c.getByRole("button", { name: "Complete consultation" }).click();
  await c.getByRole("alertdialog").getByRole("button", { name: "Complete" }).click();
  await expect(c.getByText("Consultation completed")).toBeVisible();

  // Patient leaves feedback.
  await p.goto(`/patient/appointments/${id}/feedback`);
  await expect(p.getByText(/Please don't include medical details/)).toBeVisible();
  await p.getByRole("radio", { name: "5 stars" }).first().check({ force: true });
  await p.getByLabel("Comment (optional)").fill("Very clear explanations.");
  await p.getByRole("button", { name: "Send feedback" }).click();
  await expect(p.getByText("Thanks for your feedback")).toBeVisible();
  await expect(p.getByRole("button", { name: "Update feedback" })).toBeVisible();

  // Staff can moderate it.
  await page.goto("/staff/ratings");
  await expect(page.getByText("Very clear explanations.")).toBeVisible();

  await patient.context.close();
  await clinician.context.close();
});

test("withdrawing consent removes the recording option", async ({ page, browser }) => {
  const id = APPT(101); // Olivia with Dr Rao; Olivia already consented in the seed
  await login(page, ACCOUNTS.staff, /\/staff$/);
  await page.goto(`/staff/visits/${id}`);
  await page.getByRole("button", { name: "Check in" }).click();
  await expect(page.getByText("Checked in").first()).toBeVisible();

  const clinician = await asUser(browser, ACCOUNTS.rao, /\/clinician$/);
  await mockCall(clinician.page, "giveConsent", id, "v1", "in_app");

  const patient = await asUser(browser, ACCOUNTS.olivia, /\/patient$/);
  const p = patient.page;
  await p.goto(`/patient/appointments/${id}/live`);
  await expect(p.getByText("You: agreed")).toBeVisible();
  await expect(p.getByRole("button", { name: "Start recording" })).toBeVisible();
  await p.getByRole("button", { name: "Withdraw consent" }).click();
  await p.getByRole("alertdialog").getByRole("button", { name: "Withdraw consent" }).click();
  await expect(p.getByRole("button", { name: "I agree to recording" })).toBeVisible();
  await expect(p.getByRole("button", { name: "Start recording" })).toHaveCount(0);
  await patient.context.close();
  await clinician.context.close();
});
