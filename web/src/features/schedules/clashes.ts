// Bookings that clash with leave, as in the comment on sync_slot_blocks():
// leave never touches booked slots, so these need a phone call.
import type { Appointment, ScheduleException } from "@/types/db";

export function clashingBookings<T extends Appointment>(
  e: Pick<ScheduleException, "exception_type" | "clinician_id" | "facility_id" | "starts_at" | "ends_at">,
  appointments: T[],
): T[] {
  if (e.exception_type !== "unavailable") return [];
  return appointments.filter(
    (a) =>
      a.clinician_id === e.clinician_id &&
      (e.facility_id === null || e.facility_id === a.facility_id) &&
      (a.status === "booked" || a.status === "confirmed") &&
      a.scheduled_start < e.ends_at &&
      e.starts_at < a.scheduled_end,
  );
}
