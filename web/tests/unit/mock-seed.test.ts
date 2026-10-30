// The mock data mirrors supabase/seed/01-03: same ids, names, dates relative to today.
import { describe, expect, it } from "vitest";
import { APPT, buildSeed, CLIN, FAC, PAT } from "@/lib/mock/seed";
import { authId } from "@/lib/mock/users";
import { addDays, isoDow, localDate, todayUtc } from "@/lib/time";

const NOW = new Date("2026-10-30T01:00:00Z"); // a Friday, 11 am in Brisbane

describe("mock seed", () => {
  const s = buildSeed(NOW);

  it("has the seed's reference rows with the same ids", () => {
    expect(s.residency_statuses).toHaveLength(8);
    expect(s.insurance_providers).toHaveLength(4);
    expect(s.insurance_plans).toHaveLength(6);
    expect(s.facilities.map((f) => f.id)).toEqual([FAC(1), FAC(2), FAC(3), FAC(4)]);
    expect(s.facilities[3].timezone).toBe("Australia/Sydney");
    expect(s.clinicians).toHaveLength(6);
    expect(s.clinicians[5].last_name).toBe("O'Connor");
    expect(s.patients).toHaveLength(8);
    expect(s.patients[0]).toMatchObject({ id: PAT(1), first_name: "Olivia", preferred_name: "Liv", medicare_number: "2953176541" });
    expect(s.clinician_qualifications).toHaveLength(11);
    expect(s.clinician_registrations).toHaveLength(7);
    expect(s.clinician_affiliations).toHaveLength(8);
    expect(s.patient_addresses).toHaveLength(11);
    expect(s.patient_residency).toHaveLength(9);
    expect(s.patient_insurance_policies).toHaveLength(10);
  });

  it("puts history dates relative to today", () => {
    const today = todayUtc(NOW);
    const rao = s.clinician_affiliations.filter((a) => a.clinician_id === CLIN(1));
    expect(rao.map((a) => [a.facility_id, a.valid_to])).toEqual([
      [FAC(2), addDays(today, -90)],
      [FAC(1), null],
    ]);
    const southbank = s.facility_billing_policies.filter((b) => b.facility_id === FAC(1));
    expect(southbank.map((b) => b.billing_policy)).toEqual(["bulk_billed", "mixed"]);
  });

  it("has 15 past appointments on weekdays, with status history", () => {
    const past = s.appointments.filter((a) => a.id <= APPT(15));
    expect(past).toHaveLength(15);
    for (const a of past) {
      const tz = s.facilities.find((f) => f.id === a.facility_id)!.timezone;
      expect(isoDow(localDate(a.scheduled_start, tz))).toBeLessThanOrEqual(5);
    }
    const olivia2 = s.appointments.find((a) => a.id === APPT(2))!;
    expect(olivia2.status).toBe("completed");
    const hist = s.appointment_status_history.filter((h) => h.appointment_id === APPT(2)).map((h) => h.to_status);
    expect(hist).toEqual(["booked", "confirmed", "checked_in", "in_consultation", "completed"]);
    expect(s.appointments.find((a) => a.id === APPT(14))!.rescheduled_to_appointment_id).toBe(APPT(15));
  });

  it("generates future slots in the clinic's time zone, with leave blocked", () => {
    const future = s.appointment_slots.filter((x) => x.starts_at > NOW.toISOString());
    expect(future.length).toBeGreaterThan(500);
    const kim = future.find((x) => x.clinician_id === CLIN(5))!; // Sydney, 09:00 local
    expect(new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", hour: "numeric", hour12: false }).format(new Date(kim.starts_at))).toMatch(/^(09|9|1[01])$/);
    const williamsBlocked = future.filter((x) => x.clinician_id === CLIN(3) && x.status === "blocked");
    expect(williamsBlocked.length).toBeGreaterThan(0);
    const saturday = future.filter((x) => x.source_exception_id !== null);
    expect(saturday).toHaveLength(8); // 09:00-11:00 in 15-minute slots
  });

  it("books the upcoming appointments like _book_slot, confirms and cancels like the seed", () => {
    const upcoming = s.appointments.filter((a) => a.scheduled_start > NOW.toISOString());
    expect(upcoming).toHaveLength(9); // seed 01's eight + seed 07's iron studies review
    const lukas = upcoming.find((a) => a.patient_id === PAT(6))!;
    expect(lukas.status).toBe("cancelled");
    expect(upcoming.some((a) => a.status === "confirmed")).toBe(true);
    for (const a of upcoming) {
      const slot = s.appointment_slots.find((x) => x.id === a.slot_id)!;
      expect(slot.status).toBe(a.status === "cancelled" ? "available" : "booked");
    }
  });

  it("has consents, sessions, transcripts, ratings, claims and vitals", () => {
    expect(s.recording_consents).toHaveLength(13); // + seed 07's fatigue visit (v2)
    expect(s.recording_sessions).toHaveLength(7);
    expect(s.consult_transcripts.map((t) => t.status)).toEqual(["approved", "pending_patient_review", "approved"]);
    expect(s.clinician_ratings).toHaveLength(8);
    expect(s.clinician_ratings.find((r) => r.appointment_id === APPT(8))!.moderation_status).toBe("hidden");
    expect(s.insurance_claims.map((c) => c.status)).toEqual(["paid", "submitted", "rejected", "draft"]);
    expect(s.visit_vitals).toHaveLength(15);
    expect(s.visit_vitals.find((v) => v.appointment_id === APPT(1))!.bmi).toBe(23);
  });

  it("links the test logins by email (02_link_test_logins.sql)", () => {
    expect(s.patients.find((p) => p.id === PAT(1))!.auth_user_id).toBe(authId(1));
    expect(s.clinicians.find((c) => c.id === CLIN(1))!.auth_user_id).toBe(authId(11));
    expect(s.patients.find((p) => p.id === PAT(4))!.auth_user_id).toBeNull();
    expect(s.users.find((u) => u.email === "reception.southbank@example.com")!.app_metadata.role).toBe("staff");
  });
});
