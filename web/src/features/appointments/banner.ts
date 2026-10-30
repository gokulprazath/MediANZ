// "Your appointment with Dr Rao is at 2:30 pm today", from 4 hours before the start.
import { clinicianShortName } from "@/lib/format";
import { addDays, formatTime, localDate } from "@/lib/time";
import type { AppointmentWithRefs } from "@/types/db";

export const BANNER_LEAD_MS = 4 * 60 * 60 * 1000;
const ACTIVE = new Set(["booked", "confirmed", "checked_in", "in_consultation"]);

export function nextAppointment(rows: AppointmentWithRefs[], now = new Date()): AppointmentWithRefs | null {
  return (
    rows
      .filter((a) => ACTIVE.has(a.status) && new Date(a.scheduled_end).getTime() > now.getTime())
      .sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start))[0] ?? null
  );
}

export function appointmentBanner(a: AppointmentWithRefs | null, now = new Date()): string | null {
  if (!a || !ACTIVE.has(a.status)) return null;
  const start = new Date(a.scheduled_start).getTime();
  const end = new Date(a.scheduled_end).getTime();
  if (now.getTime() < start - BANNER_LEAD_MS || now.getTime() > end) return null;
  const tz = a.facility.timezone;
  const day = localDate(a.scheduled_start, tz);
  const today = localDate(now, tz);
  const when = day === today ? "today" : day === addDays(today, 1) ? "tomorrow" : "";
  return `Your appointment with ${clinicianShortName(a.clinician)} is at ${formatTime(a.scheduled_start, tz)}${when ? ` ${when}` : ""}`;
}
