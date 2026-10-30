// Clinic reports computed in the browser from rows staff can read (6.4).
import { minutesBetween } from "@/lib/time";
import type { Appointment, AppointmentSlot } from "@/types/db";

const LIVE = (a: Appointment) => a.status !== "cancelled" && a.status !== "rescheduled";

/** No-shows as a share of appointments that were due (attended or not). */
export function noShowRate(appointments: Appointment[]): { rate: number | null; noShows: number; due: number } {
  const due = appointments.filter((a) => a.status === "completed" || a.status === "no_show" || a.status === "in_consultation" || a.status === "checked_in");
  const noShows = due.filter((a) => a.status === "no_show").length;
  return { rate: due.length ? noShows / due.length : null, noShows, due: due.length };
}

/** Wait = consult start minus check-in, in minutes, over visits with both. */
export function averageWait(appointments: Appointment[]): { minutes: number | null; visits: number } {
  const waits = appointments
    .map((a) => minutesBetween(a.checked_in_at, a.consult_started_at))
    .filter((m): m is number => m !== null && m >= 0);
  return { minutes: waits.length ? waits.reduce((s, m) => s + m, 0) / waits.length : null, visits: waits.length };
}

export function consultLength(a: Appointment): number | null {
  return minutesBetween(a.consult_started_at, a.consult_ended_at);
}

export function waitMinutes(a: Appointment): number | null {
  return minutesBetween(a.checked_in_at, a.consult_started_at);
}

export interface Utilisation {
  clinicianId: string;
  offered: number; // slots that could be booked (not blocked)
  booked: number; // slots with a live appointment
  rate: number | null;
}

/** Booked slots as a share of offered (non-blocked) slots, per clinician. */
export function utilisation(slots: AppointmentSlot[], appointments: Appointment[]): Utilisation[] {
  const bookedSlots = new Set(appointments.filter(LIVE).map((a) => a.slot_id));
  const by = new Map<string, Utilisation>();
  for (const s of slots) {
    const u = by.get(s.clinician_id) ?? { clinicianId: s.clinician_id, offered: 0, booked: 0, rate: null };
    if (s.status !== "blocked" || bookedSlots.has(s.id)) u.offered++;
    if (bookedSlots.has(s.id) || s.status === "booked") u.booked++;
    by.set(s.clinician_id, u);
  }
  return [...by.values()].map((u) => ({ ...u, rate: u.offered ? u.booked / u.offered : null }));
}

export function formatPercent(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 1000) / 10}%`;
}
