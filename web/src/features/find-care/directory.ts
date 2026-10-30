// The clinic directory behind the map and list (4.3), built entirely from rows
// any signed-in user can read, plus get_available_slots for the next 7 days.
import { validOn } from "@/lib/history";
import { haversineKm, type LatLng } from "@/lib/geo";
import { localDate } from "@/lib/time";
import type {
  AvailableSlot,
  BillingPolicy,
  Clinician,
  ClinicianAffiliation,
  ClinicianQualification,
  ClinicianRatingSummary,
  Facility,
  FacilityBillingPolicy,
} from "@/types/db";

export type Availability = "today" | "week" | "none";

export const AVAILABILITY_LEGEND: Record<Availability, { label: string; short: string; colour: string; border: string }> = {
  today: { label: "Appointment available today", short: "Today", colour: "#15803d", border: "#14532d" },
  week: { label: "Available within 7 days", short: "This week", colour: "#d97706", border: "#78350f" },
  none: { label: "No appointments in the next 7 days", short: "None", colour: "#6b7280", border: "#374151" },
};

export interface ClinicianEntry {
  clinician: Clinician;
  qualifications: string[];
  rating: ClinicianRatingSummary | null;
  nextAvailable: AvailableSlot | null;
}

export interface ClinicEntry {
  facility: Facility;
  distanceKm: number | null;
  billing: BillingPolicy | null;
  clinicians: ClinicianEntry[];
  nextAvailable: AvailableSlot | null;
  availability: Availability;
  rating: number | null; // average of clinician averages, weighted by count
  ratingCount: number;
}

export interface DirectoryInput {
  facilities: Facility[];
  affiliations: ClinicianAffiliation[];
  clinicians: Clinician[];
  billing: FacilityBillingPolicy[];
  qualifications: ClinicianQualification[];
  ratings: ClinicianRatingSummary[];
  slotsByFacility: Record<string, AvailableSlot[] | undefined>;
  location: LatLng | null;
  radiusKm: number;
  now?: Date;
}

export function buildDirectory(input: DirectoryInput): ClinicEntry[] {
  const now = input.now ?? new Date();
  const out: ClinicEntry[] = [];
  for (const f of input.facilities) {
    if (!f.is_active || f.latitude === null || f.longitude === null) continue;
    const distanceKm = input.location ? haversineKm(input.location, { lat: f.latitude, lng: f.longitude }) : null;
    if (distanceKm !== null && distanceKm > input.radiusKm) continue;

    const today = localDate(now, f.timezone);
    const slots = [...(input.slotsByFacility[f.id] ?? [])].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    const clinicians = input.affiliations
      .filter((a) => a.facility_id === f.id && validOn(a, today))
      .map((a) => input.clinicians.find((c) => c.id === a.clinician_id))
      .filter((c): c is Clinician => !!c && c.is_active)
      .map((c) => ({
        clinician: c,
        qualifications: input.qualifications.filter((q) => q.clinician_id === c.id).map((q) => q.qualification),
        rating: input.ratings.find((r) => r.clinician_id === c.id) ?? null,
        nextAvailable: slots.find((s) => s.clinician_id === c.id) ?? null,
      }));

    const nextAvailable = slots[0] ?? null;
    const availability: Availability = !nextAvailable
      ? "none"
      : slots.some((s) => localDate(s.starts_at, f.timezone) === today)
        ? "today"
        : "week";
    const rated = clinicians.map((c) => c.rating).filter((r): r is ClinicianRatingSummary => !!r && r.avg_rating !== null);
    const ratingCount = rated.reduce((n, r) => n + Number(r.rating_count), 0);
    const rating = ratingCount
      ? rated.reduce((sum, r) => sum + Number(r.avg_rating) * Number(r.rating_count), 0) / ratingCount
      : null;

    out.push({
      facility: f,
      distanceKm,
      billing: input.billing.find((b) => b.facility_id === f.id && validOn(b, today))?.billing_policy ?? null,
      clinicians,
      nextAvailable,
      availability,
      rating,
      ratingCount,
    });
  }
  return out;
}

export type SortKey = "distance" | "next" | "rating";

export function sortDirectory(entries: ClinicEntry[], key: SortKey): ClinicEntry[] {
  const inf = Number.POSITIVE_INFINITY;
  return [...entries].sort((a, b) => {
    if (key === "distance") return (a.distanceKm ?? inf) - (b.distanceKm ?? inf) || a.facility.name.localeCompare(b.facility.name);
    if (key === "next") {
      const ta = a.nextAvailable ? Date.parse(a.nextAvailable.starts_at) : inf;
      const tb = b.nextAvailable ? Date.parse(b.nextAvailable.starts_at) : inf;
      return ta - tb || a.facility.name.localeCompare(b.facility.name);
    }
    return (b.rating ?? -1) - (a.rating ?? -1) || a.facility.name.localeCompare(b.facility.name);
  });
}
