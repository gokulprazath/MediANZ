// The clinic whose time zone the clinician's own screens use: the affiliation
// in force today (the earliest one if several), else any clinic they work at.
import { validOn } from "@/lib/history";
import type { ClinicianAffiliation, Facility } from "@/types/db";

export function affiliatedClinics(affiliations: ClinicianAffiliation[], facilities: Facility[], today: string): Facility[] {
  const current = affiliations.filter((a) => validOn(a, today));
  const ids = new Set((current.length ? current : affiliations).map((a) => a.facility_id));
  return facilities.filter((f) => ids.has(f.id));
}
