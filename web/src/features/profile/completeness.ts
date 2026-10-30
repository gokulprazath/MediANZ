// Profile completeness for the indicator at the top of /patient/profile.
import { validOn } from "@/lib/history";
import { todayUtc } from "@/lib/time";
import type { Patient, PatientAddress, PatientResidency, ResidencyStatus } from "@/types/db";

export interface CompletenessItem {
  key: string;
  label: string;
  done: boolean;
}

export function profileCompleteness(
  patient: Patient,
  addresses: PatientAddress[],
  residency: PatientResidency[],
  statuses: ResidencyStatus[],
  today = todayUtc(),
): { items: CompletenessItem[]; done: number; total: number; percent: number } {
  const currentResidency = residency.find((r) => validOn(r, today));
  const medicareEligible = currentResidency
    ? (statuses.find((s) => s.id === currentResidency.residency_status_id)?.medicare_eligible ?? true)
    : true;
  const items: CompletenessItem[] = [
    {
      key: "personal",
      label: "Personal details",
      done: !!(patient.first_name && patient.last_name && patient.date_of_birth && patient.sex && patient.phone && patient.email),
    },
    {
      key: "medicare",
      label: "Medicare",
      // Not needed when the current residency status isn't Medicare-eligible.
      done: !medicareEligible || !!(patient.medicare_number && patient.medicare_irn && patient.medicare_expiry),
    },
    {
      key: "emergency",
      label: "Emergency contact",
      done: !!(patient.emergency_contact_name && patient.emergency_contact_phone),
    },
    { key: "blood", label: "Blood type", done: !!patient.blood_type },
    {
      key: "address",
      label: "Home address",
      done: addresses.some((a) => a.address_type === "residential" && validOn(a, today)),
    },
    { key: "residency", label: "Residency or visa", done: !!currentResidency },
  ];
  const done = items.filter((i) => i.done).length;
  return { items, done, total: items.length, percent: Math.round((done / items.length) * 100) };
}
