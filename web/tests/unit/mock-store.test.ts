// The mock store emulates RLS, RPC bodies and triggers. These tests pin the
// rules the screens rely on.
import { beforeEach, describe, expect, it } from "vitest";
import type { DataApi } from "@/lib/data/api";
import { APPT, buildSeed, CLIN, FAC, PAT, type MockState } from "@/lib/mock/seed";
import { createMockApi } from "@/lib/mock/store";
import { authId } from "@/lib/mock/users";
import { addDays, todayUtc } from "@/lib/time";

const NOW = new Date("2026-10-30T01:00:00Z"); // Friday, 11 am in Brisbane
let clock = NOW;
const now = () => clock;

let state: MockState;
let olivia: DataApi;
let jack: DataApi;
let rao: DataApi;
let staff: DataApi;

beforeEach(() => {
  clock = NOW;
  state = buildSeed(NOW);
  olivia = createMockApi(state, authId(1), { now });
  jack = createMockApi(state, authId(2), { now });
  rao = createMockApi(state, authId(11), { now });
  staff = createMockApi(state, authId(21), { now });
});

const monday = addDays(todayUtc(NOW), 3);
const audio = () => new Blob([new Uint8Array(2048)], { type: "audio/webm" });

async function firstSlot(api: DataApi, date = monday) {
  const slots = await api.getAvailableSlots({ date, clinicianId: CLIN(1), facilityId: FAC(1) });
  expect(slots.length).toBeGreaterThan(1);
  return slots;
}

describe("booking RPCs", () => {
  it("holds and books a slot, and hides it from others", async () => {
    const [slot] = await firstSlot(olivia);
    const heldUntil = await olivia.holdSlot(slot.slot_id);
    expect(Date.parse(heldUntil) - NOW.getTime()).toBe(5 * 60_000);
    const forJack = await jack.getAvailableSlots({ date: monday, clinicianId: CLIN(1), facilityId: FAC(1) });
    expect(forJack.some((s) => s.slot_id === slot.slot_id)).toBe(false);
    await expect(jack.holdSlot(slot.slot_id)).rejects.toThrow(/Slot is no longer available/);

    const id = await olivia.bookSlot({ slotId: slot.slot_id, reason: "Check-up", visitType: "standard" });
    const a = await olivia.getAppointment(id);
    expect(a).toMatchObject({ status: "booked", patient_id: PAT(1), reason: "Check-up" });
    expect((await olivia.getSlot(slot.slot_id))?.status).toBe("booked");
    // RLS: another patient can't read it.
    expect(await jack.getAppointment(id)).toBeNull();
  });

  it("cancels (slot freed) and reschedules (old row marked, new booked)", async () => {
    const [s1, s2, s3] = await firstSlot(olivia);
    await olivia.holdSlot(s1.slot_id);
    const id = await olivia.bookSlot({ slotId: s1.slot_id });
    await olivia.cancelAppointment(id, "Feeling better");
    expect((await olivia.getAppointment(id))?.status).toBe("cancelled");
    expect((await olivia.getSlot(s1.slot_id))?.status).toBe("available");

    await olivia.holdSlot(s2.slot_id);
    const id2 = await olivia.bookSlot({ slotId: s2.slot_id });
    const newId = await olivia.rescheduleAppointment(id2, s3.slot_id);
    const old = await olivia.getAppointment(id2);
    expect(old?.status).toBe("rescheduled");
    expect(old?.rescheduled_to_appointment_id).toBe(newId);
    expect((await olivia.getAppointment(newId))?.slot_id).toBe(s3.slot_id);
    expect((await olivia.getSlot(s2.slot_id))?.status).toBe("available");
  });

  it("only staff can book for another patient", async () => {
    const [slot] = await firstSlot(staff);
    await expect(olivia.bookSlot({ slotId: slot.slot_id, patientId: PAT(2) })).rejects.toThrow(/Only staff/);
    const id = await staff.bookSlot({ slotId: slot.slot_id, patientId: PAT(2), channel: "reception" });
    expect((await staff.getAppointment(id))?.booking_channel).toBe("reception");
  });

  it("rejects an invalid status change", async () => {
    await expect(staff.updateAppointment(APPT(101), { status: "completed" })).rejects.toThrow(/Invalid appointment status change/);
  });
});

async function checkedIn() {
  await staff.updateAppointment(APPT(101), { status: "checked_in" });
  const a = await rao.getAppointment(APPT(101));
  expect(a?.status).toBe("checked_in");
  expect(a?.checked_in_at).not.toBeNull();
}

describe("consent, recording and transcripts", () => {
  it("needs both consents, stores chunks and finalizes a draft", async () => {
    await checkedIn();
    await olivia.giveConsent(APPT(101), "v1", "in_app");
    await expect(rao.transcribeStart(APPT(101))).rejects.toThrow(/Both patient and clinician must consent/);
    await rao.giveConsent(APPT(101), "v1", "in_app");
    const consents = await olivia.listConsents(APPT(101));
    expect(consents.map((c) => c.party).sort()).toEqual(["clinician", "patient"]);

    const { session_id } = await rao.transcribeStart(APPT(101));
    expect((await rao.transcribeChunk(session_id, 1, audio(), 900)).status).toBe("stored");
    expect((await rao.transcribeChunk(session_id, 2, audio(), 120)).status).toBe("stored");
    // Retrying the same seq replaces it.
    expect((await rao.transcribeChunk(session_id, 2, audio(), 125)).status).toBe("stored");
    const res = await rao.transcribeFinish(session_id);
    expect(res.status).toBe("pending_patient_review");

    const [session] = await olivia.listRecordingSessions([APPT(101)]);
    expect(session).toMatchObject({ status: "awaiting_review", duration_seconds: 1025 });
    const t = (await olivia.getTranscript(res.transcript_id!))!;
    expect(t.status).toBe("pending_patient_review");
    expect(t.segments?.map((s) => s.chunk)).toEqual([1, 1, 2, 2]);
    expect(t.segments?.[2].start_sec).toBe(900);
    // The clinician sees it only after approval.
    expect(await rao.listTranscripts([APPT(101)])).toHaveLength(0);
    await olivia.approveTranscript(t.id);
    expect(await rao.listTranscripts([APPT(101)])).toHaveLength(1);
    await expect(olivia.approveTranscript(t.id)).rejects.toThrow(/not awaiting review/);
  });

  it("rejecting deletes the draft; withdrawing consent deletes transcripts and stops recording", async () => {
    await checkedIn();
    await olivia.giveConsent(APPT(101), "v1");
    await rao.giveConsent(APPT(101), "v1");
    let { session_id } = await rao.transcribeStart(APPT(101));
    await rao.transcribeChunk(session_id, 1, audio(), 30);
    const { transcript_id } = await rao.transcribeFinish(session_id);
    await olivia.rejectTranscript(transcript_id!);
    expect(await olivia.getTranscript(transcript_id!)).toBeNull();
    expect((await olivia.listRecordingSessions([APPT(101)]))[0].status).toBe("rejected");

    ({ session_id } = await olivia.transcribeStart(APPT(101)));
    await olivia.withdrawConsent(APPT(101));
    const chunk = await rao.transcribeChunk(session_id, 1, audio(), 30).catch((e: Error) => e);
    expect(chunk instanceof Error ? chunk.message : chunk.status).toMatch(/discarded|no longer open|not open/);
    const s = (await olivia.listRecordingSessions([APPT(101)])).find((x) => x.id === session_id);
    expect(s?.status).toBe("consent_withdrawn");
  });

  it("cancel marks the session failed and keeps nothing", async () => {
    await checkedIn();
    await olivia.giveConsent(APPT(101), "v1");
    await rao.giveConsent(APPT(101), "v1");
    const { session_id } = await rao.transcribeStart(APPT(101));
    await rao.transcribeChunk(session_id, 1, audio(), 30);
    await rao.transcribeCancel(session_id);
    const s = (await rao.listRecordingSessions([APPT(101)]))[0];
    expect(s.status).toBe("failed");
    expect(await olivia.listTranscripts([APPT(101)])).toHaveLength(0);
  });

  it("refuses recording before check-in", async () => {
    await olivia.giveConsent(APPT(101), "v1");
    await rao.giveConsent(APPT(101), "v1");
    await expect(rao.transcribeStart(APPT(101))).rejects.toThrow(/only allowed during the consultation/);
  });
});

describe("vitals", () => {
  it("are allowed once checked in and follow the SQL checks", async () => {
    const input = { temperature_c: 37, spo2_percent: 98, bp_systolic: 120, bp_diastolic: 80, height_cm: 170, weight_kg: 70, notes: null };
    await expect(rao.addVitals(APPT(101), input)).rejects.toThrow(/checked in/);
    await checkedIn();
    const v = await rao.addVitals(APPT(101), input);
    expect(v.bmi).toBeCloseTo(24.2, 1);
    await expect(rao.addVitals(APPT(101), { ...input, bp_systolic: 70, bp_diastolic: 80 })).rejects.toMatchObject({ code: "23514" });
    const latest = await rao.listVitalsLatest(PAT(1));
    expect(latest.find((x) => x.appointment_id === APPT(101))?.bp_systolic).toBe(120);
  });
});

describe("ratings", () => {
  async function completeVisit() {
    await checkedIn();
    await rao.updateAppointment(APPT(101), { status: "in_consultation" });
    await rao.updateAppointment(APPT(101), { status: "completed" });
  }
  const input = { rating: 4, rating_communication: 5, rating_wait_time: 3, would_recommend: true, comment: "Great", is_anonymous: true };

  it("only the patient of a completed visit can rate, once", async () => {
    expect(await olivia.canRateAppointment(APPT(101))).toBe(false);
    await completeVisit();
    expect(await olivia.canRateAppointment(APPT(101))).toBe(true);
    expect(await jack.canRateAppointment(APPT(101))).toBe(false);
    await expect(jack.createRating(APPT(101), input)).rejects.toMatchObject({ code: "42501" });
    const r = await olivia.createRating(APPT(101), input);
    expect(r).toMatchObject({ clinician_id: CLIN(1), moderation_status: "visible" });
    await expect(olivia.createRating(APPT(101), input)).rejects.toMatchObject({ code: "23505" });
    const mine = await rao.getMyRatingsAsClinician();
    expect(mine.find((x) => x.rating_id === r.id)?.patient_display_name).toBeNull();
  });

  it("is editable for 30 days, and hidden ratings leave the averages", async () => {
    await completeVisit();
    const r = await olivia.createRating(APPT(101), input);
    await olivia.updateRating(r.id, { ...input, rating: 2 });
    const before = (await olivia.getRatingSummary(CLIN(1)))[0];
    await expect(olivia.moderateRating(r.id, "hidden")).rejects.toThrow();
    await staff.moderateRating(r.id, "hidden");
    const after = (await olivia.getRatingSummary(CLIN(1)))[0];
    expect(after?.rating_count ?? 0).toBe(before.rating_count - 1);
    clock = new Date(NOW.getTime() + 31 * 86_400_000);
    await expect(olivia.updateRating(r.id, input)).rejects.toThrow();
  });
});

describe("history-aware profile edits", () => {
  it("changing an address ends the current row today and adds a new one", async () => {
    const before = await olivia.listAddresses(PAT(1));
    const current = before.find((a) => a.address_type === "residential" && a.valid_to === null)!;
    const added = await olivia.changeAddress(PAT(1), {
      address_type: "residential",
      address_line1: "1 New St",
      address_line2: null,
      suburb: "Paddington",
      state: "QLD",
      postcode: "4064",
      country: "Australia",
    });
    const after = await olivia.listAddresses(PAT(1));
    expect(after.find((a) => a.id === current.id)?.valid_to).toBe(todayUtc(NOW));
    expect(added).toMatchObject({ valid_from: todayUtc(NOW), valid_to: null });
    expect(after).toHaveLength(before.length + 1);
  });
});

describe("claims", () => {
  it("fills the policy from the visit date, or refuses without one", async () => {
    const withPolicy = state.appointments.find((a) => a.patient_insurance_policy_id && a.status === "completed")!;
    const claim = await staff.createClaim({ appointment_id: withPolicy.id, amount_claimed: 50 });
    expect(claim.patient_insurance_policy_id).toBe(withPolicy.patient_insurance_policy_id);
    await expect(olivia.createClaim({ appointment_id: withPolicy.id, amount_claimed: 50 })).rejects.toMatchObject({ code: "42501" });
    const without = state.appointments.find((a) => !a.patient_insurance_policy_id)!;
    await expect(staff.createClaim({ appointment_id: without.id, amount_claimed: 10 })).rejects.toThrow(/no insurance policy/);
    const updated = await staff.updateClaim(claim.id, { status: "rejected", rejection_reason: "Not covered" });
    expect(updated.processed_at).not.toBeNull();
  });
});
