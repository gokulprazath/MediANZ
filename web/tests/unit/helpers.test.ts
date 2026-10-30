// Pure helpers: emergency words, directory, banner, .ics, reports, errors,
// fees default and transcript turns.
import { describe, expect, it, vi } from "vitest";
import { containsEmergencyWords } from "@/config/emergency";
import { appointmentBanner, nextAppointment } from "@/features/appointments/banner";
import { defaultGap } from "@/features/appointments/fees-form";
import { speakerTurns, formatOffset } from "@/features/consult/transcript";
import { buildDirectory, sortDirectory } from "@/features/find-care/directory";
import { demoRole, DEMO_ROLES, isDemoSession } from "@/lib/auth/demo";
import { DataError } from "@/lib/data/api";
import { visibleHours } from "@/lib/time";
import { historyFor, type Turn } from "@/features/assistant/conversation";
import { friendlyError } from "@/lib/errors";
import { buildIcs } from "@/lib/ics";
import { buildSeed, CLIN, FAC } from "@/lib/mock/seed";
import { averageWait, consultLength, formatPercent, noShowRate, utilisation, waitMinutes } from "@/lib/reports";
import type { Appointment, AppointmentSlot, AppointmentWithRefs, AvailableSlot } from "@/types/db";

const NOW = new Date("2026-10-30T01:00:00Z"); // 11 am Brisbane

describe("containsEmergencyWords", () => {
  it("matches whole phrases, case-insensitively", () => {
    expect(containsEmergencyWords("I have CHEST PAIN since this morning")).toBe(true);
    expect(containsEmergencyWords("I can’t breathe")).toBe(true);
    expect(containsEmergencyWords("Repeat prescription")).toBe(false);
    expect(containsEmergencyWords("")).toBe(false);
  });
});

function appt(partial: Partial<AppointmentWithRefs>): AppointmentWithRefs {
  return {
    id: "a1",
    status: "confirmed",
    scheduled_start: "2026-10-30T04:30:00Z",
    scheduled_end: "2026-10-30T04:45:00Z",
    clinician: { id: "c", first_name: "Asha", last_name: "Rao", clinician_type: "gp", specialty: null },
    facility: {
      id: "f",
      name: "Southbank Family Medical",
      timezone: "Australia/Brisbane",
      address_line1: "1 Grey St",
      suburb: "South Brisbane",
      state: "QLD",
      postcode: "4101",
      phone: null,
    },
    patient: null,
    reason: "Private reason",
    ...partial,
  } as AppointmentWithRefs;
}

describe("appointmentBanner", () => {
  it("shows from 4 hours before, in the clinic's time", () => {
    const a = appt({});
    expect(appointmentBanner(a, new Date("2026-10-29T23:00:00Z"))).toBeNull(); // 5.5 h before
    expect(appointmentBanner(a, NOW)).toBe("Your appointment with Dr Rao is at 2:30 pm today");
    expect(appointmentBanner(appt({ status: "cancelled" }), NOW)).toBeNull();
    expect(appointmentBanner(a, new Date("2026-10-30T05:00:00Z"))).toBeNull(); // after it ended
  });
  it("picks the next active appointment", () => {
    const rows = [appt({ id: "x", status: "cancelled" }), appt({ id: "y", scheduled_start: "2026-11-02T00:00:00Z", scheduled_end: "2026-11-02T00:15:00Z" }), appt({ id: "z" })];
    expect(nextAppointment(rows, NOW)?.id).toBe("z");
  });
});

describe("buildIcs", () => {
  it("has the time and place but not the reason", () => {
    const ics = buildIcs(appt({}), NOW);
    expect(ics).toContain("DTSTART:20261030T043000Z");
    expect(ics).toContain("SUMMARY:Appointment with Dr Asha Rao");
    expect(ics).toContain("Southbank Family Medical");
    expect(ics).not.toContain("Private reason");
    expect(ics.split("\r\n").every((l) => l.length <= 75)).toBe(true);
  });
});

describe("buildDirectory", () => {
  const s = buildSeed(NOW);
  const slot = (facilityId: string, clinicianId: string, startsAt: string): AvailableSlot => ({
    slot_id: startsAt,
    starts_at: startsAt,
    ends_at: startsAt,
    local_start: startsAt,
    clinician_id: clinicianId,
    clinician_name: "",
    clinician_type: "gp",
    specialty: null,
    facility_id: facilityId,
    facility_name: "",
    facility_tz: "Australia/Brisbane",
  });
  const input = {
    facilities: s.facilities,
    affiliations: s.clinician_affiliations,
    clinicians: s.clinicians,
    billing: s.facility_billing_policies,
    qualifications: s.clinician_qualifications,
    ratings: [],
    slotsByFacility: {
      [FAC(1)]: [slot(FAC(1), CLIN(1), "2026-10-30T05:00:00Z")],
      [FAC(2)]: [slot(FAC(2), CLIN(3), "2026-11-03T00:00:00Z")],
    },
    location: { lat: -27.4785, lng: 153.0206 }, // South Brisbane
    radiusKm: 10,
    now: NOW,
  };
  it("filters by radius and flags availability", () => {
    const d = buildDirectory(input);
    expect(d.every((e) => (e.distanceKm ?? 0) <= 10)).toBe(true);
    expect(d.find((e) => e.facility.id === FAC(1))?.availability).toBe("today");
    expect(d.find((e) => e.facility.id === FAC(2))?.availability).toBe("week");
    expect(d.find((e) => e.facility.id === FAC(1))?.clinicians.map((c) => c.clinician.id)).toContain(CLIN(1));
    // Sydney is well outside 10 km.
    expect(d.some((e) => e.facility.id === FAC(4))).toBe(false);
    expect(sortDirectory(d, "next")[0].facility.id).toBe(FAC(1));
  });
});

const base = { checked_in_at: null, consult_started_at: null, consult_ended_at: null, status: "completed" } as Partial<Appointment>;
const A = (p: Partial<Appointment>) => ({ ...base, ...p }) as Appointment;

describe("reports", () => {
  const rows = [
    A({ status: "completed", slot_id: "s1", clinician_id: "c", checked_in_at: "2026-10-01T00:00:00Z", consult_started_at: "2026-10-01T00:10:00Z", consult_ended_at: "2026-10-01T00:25:00Z" }),
    A({ status: "completed", slot_id: "s2", clinician_id: "c", checked_in_at: "2026-10-01T01:00:00Z", consult_started_at: "2026-10-01T01:20:00Z" }),
    A({ status: "no_show", slot_id: "s3", clinician_id: "c" }),
    A({ status: "cancelled", slot_id: "s4", clinician_id: "c" }),
  ];
  it("computes no-show rate, waits and utilisation", () => {
    expect(noShowRate(rows)).toEqual({ rate: 1 / 3, noShows: 1, due: 3 });
    expect(averageWait(rows)).toEqual({ minutes: 15, visits: 2 });
    expect(waitMinutes(rows[0])).toBe(10);
    expect(consultLength(rows[0])).toBe(15);
    expect(consultLength(rows[1])).toBeNull();
    const slots = ["s1", "s2", "s3", "s4", "s5"].map((id, i) => ({ id, clinician_id: "c", status: i === 4 ? "blocked" : "available" }) as AppointmentSlot);
    expect(utilisation(slots, rows)).toEqual([{ clinicianId: "c", offered: 4, booked: 3, rate: 0.75 }]);
    expect(formatPercent(1 / 3)).toBe("33.3%");
    expect(formatPercent(null)).toBe("—");
  });
});

describe("friendlyError", () => {
  it("maps database messages and codes to sentences", () => {
    expect(friendlyError(new DataError("Slot is no longer available", "P0001"))).toMatch(/choose another time/);
    expect(friendlyError(new DataError("Patient had no insurance policy on the visit date", "23514"))).toMatch(/no insurance policy/);
    expect(friendlyError(new DataError('violates check constraint "patients_medicare_number_check"', "23514"))).toBe("Medicare number must be 10 digits.");
    expect(friendlyError(new DataError("permission denied", "42501"))).toMatch(/permission/);
    expect(friendlyError(new TypeError("Failed to fetch"))).toMatch(/Can't reach the server/);
    expect(friendlyError(new Error("internal xyz"))).toBe("Something went wrong. Please try again.");
  });
});

describe("defaultGap", () => {
  it("is fee minus rebate, never negative", () => {
    expect(defaultGap("80", "41.40")).toBe("38.60");
    expect(defaultGap("80", "")).toBe("80.00");
    expect(defaultGap("30", "41.40")).toBe("0.00");
    expect(defaultGap("", "41.40")).toBe("");
  });
});

describe("speakerTurns", () => {
  it("falls back to the text, joins turns and numbers speakers per part", () => {
    expect(speakerTurns({ segments: null, transcript_text: "Hello" })).toEqual([{ speaker: "Transcript", startSec: null, text: "Hello" }]);
    const turns = speakerTurns({
      transcript_text: "",
      segments: [
        { speaker: "c1:speaker_0", chunk: 1, start_sec: 0, end_sec: 2, text: "Hi" },
        { speaker: "c1:speaker_0", chunk: 1, start_sec: 2, end_sec: 3, text: "there." },
        { speaker: "c1:speaker_1", chunk: 1, start_sec: 3, end_sec: 5, text: "Hello." },
        { speaker: "c2:speaker_1", chunk: 2, start_sec: 900, end_sec: 905, text: "Next." },
      ],
    });
    expect(turns).toEqual([
      { speaker: "Speaker 1 (part 1)", startSec: 0, text: "Hi there." },
      { speaker: "Speaker 2 (part 1)", startSec: 3, text: "Hello." },
      { speaker: "Speaker 1 (part 2)", startSec: 900, text: "Next." },
    ]);
    expect(formatOffset(905)).toBe("15:05");
    expect(formatOffset(3725)).toBe("1:02:05");
  });
});

describe("demo login", () => {
  it("offers patient, clinician and receptionist, with MFA for the last two", () => {
    expect(DEMO_ROLES.map((r) => [r.id, r.home, r.mfa])).toEqual([
      ["patient", "/patient", false],
      ["clinician", "/clinician", true],
      ["receptionist", "/staff", true],
    ]);
    expect(demoRole("admin")).toBeNull();
  });

  it("skips MFA only for a demo cookie on its own demo account, and only when enabled", async () => {
    expect(isDemoSession("asha.rao@example.com", "clinician")).toBe(false); // mock mode: off
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_DATA_MODE", "live");
    vi.stubEnv("DEMO_LOGIN_ENABLED", "true");
    try {
      const live = await import("@/lib/auth/demo");
      expect(live.isDemoSession("Asha.Rao@example.com", "clinician")).toBe(true);
      expect(live.isDemoSession("reception.southbank@example.com", "receptionist")).toBe(true);
      expect(live.isDemoSession("asha.rao@example.com", "receptionist")).toBe(false); // cookie for another role
      expect(live.isDemoSession("sophie.williams@example.com", "clinician")).toBe(false); // not a demo account
      expect(live.isDemoSession("asha.rao@example.com", undefined)).toBe(false); // password sign-in: MFA as usual
      expect(live.isDemoSession("asha.rao@example.com", "admin")).toBe(false);
      vi.stubEnv("DEMO_LOGIN_ENABLED", "false");
      expect(live.isDemoSession("asha.rao@example.com", "clinician")).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe("visibleHours", () => {
  const tz = "Australia/Brisbane"; // UTC+10, no daylight saving
  it("keeps the usual 7 am to 8 pm day when every visit fits", () => {
    expect(visibleHours([{ start: "2026-10-30T00:00:00Z", end: "2026-10-30T00:15:00Z" }], tz)).toEqual({
      slotMinTime: "07:00:00",
      slotMaxTime: "20:00:00",
    });
  });
  it("widens to show evening and early visits", () => {
    const evening = { start: "2026-10-30T12:20:00Z", end: "2026-10-30T12:35:00Z" }; // 10:20-10:35 pm
    const early = { start: "2026-10-29T20:30:00Z", end: "2026-10-29T20:45:00Z" }; // 6:30-6:45 am
    expect(visibleHours([evening, early], tz)).toEqual({ slotMinTime: "06:00:00", slotMaxTime: "23:00:00" });
    expect(visibleHours([{ start: "2026-10-30T13:50:00Z", end: "2026-10-30T14:05:00Z" }], tz).slotMaxTime).toBe("24:00:00");
  });
});

describe("assistant history", () => {
  it("sends the last 12 patient and assistant turns, never errors", () => {
    const turns: Turn[] = [
      { id: 1, from: "patient", text: "What was my blood pressure?" },
      { id: 2, from: "error", text: "Something went wrong." },
      { id: 3, from: "agent", agent: "insights", text: "116/74.", pending: null, proposal: null },
    ];
    expect(historyFor(turns)).toEqual([
      { role: "patient", text: "What was my blood pressure?" },
      { role: "assistant", text: "116/74." },
    ]);
    const many: Turn[] = Array.from({ length: 20 }, (_, i) => ({ id: i, from: "patient", text: `q${i} ${"x".repeat(5000)}` }));
    const sent = historyFor(many);
    expect(sent).toHaveLength(12);
    expect(sent[0].text.startsWith("q8 ")).toBe(true);
    expect(sent.every((t) => t.text.length <= 2000)).toBe(true);
    expect(JSON.stringify({ message: "x".repeat(2000), history: sent }).length).toBeLessThan(32 * 1024);
  });
});
