// Labels and number formats in Australian English.
import type {
  AppointmentStatus,
  BillingPolicy,
  ClaimStatus,
  ClinicianType,
  FacilityType,
  ModerationStatus,
  RecordingStatus,
  RegistrationStatus,
  ResidencyCategory,
  SlotStatus,
} from "@/types/db";

export const APPOINTMENT_STATUS_LABEL: Record<AppointmentStatus, string> = {
  booked: "Booked",
  confirmed: "Confirmed",
  checked_in: "Checked in",
  in_consultation: "In consultation",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "Did not attend",
  rescheduled: "Rescheduled",
};

export const SLOT_STATUS_LABEL: Record<SlotStatus, string> = {
  available: "Available",
  held: "Held",
  booked: "Booked",
  blocked: "Blocked",
};

export const FACILITY_TYPE_LABEL: Record<FacilityType, string> = {
  hospital: "Hospital",
  gp_clinic: "GP clinic",
  specialist_clinic: "Specialist clinic",
};

export const BILLING_POLICY_LABEL: Record<BillingPolicy, string> = {
  bulk_billed: "Bulk billed",
  mixed: "Mixed billing",
  private_only: "Private only",
};

export const CLINICIAN_TYPE_LABEL: Record<ClinicianType, string> = {
  gp: "GP",
  specialist: "Specialist",
  nurse: "Nurse",
  allied_health: "Allied health",
};

export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
  paid: "Paid",
};

export const RECORDING_STATUS_LABEL: Record<RecordingStatus, string> = {
  started: "Recording",
  awaiting_review: "Waiting for your review",
  approved: "Approved",
  rejected: "Rejected (deleted)",
  expired: "Expired (deleted)",
  failed: "Failed",
  consent_withdrawn: "Consent withdrawn (deleted)",
};

export const MODERATION_LABEL: Record<ModerationStatus, string> = {
  visible: "Visible",
  hidden: "Hidden",
  flagged: "Flagged for review",
};

export const REGISTRATION_STATUS_LABEL: Record<RegistrationStatus, string> = {
  registered: "Registered",
  registered_with_conditions: "Registered with conditions",
  suspended: "Suspended",
  cancelled: "Cancelled",
};

export const RESIDENCY_CATEGORY_LABEL: Record<ResidencyCategory, string> = {
  citizen: "Citizen",
  permanent_resident: "Permanent resident",
  temporary_visa: "Temporary visa",
  visitor: "Visitor",
  other: "Other",
};

export const SEX_LABEL: Record<string, string> = {
  female: "Female",
  male: "Male",
  intersex: "Intersex",
  not_stated: "Prefer not to say",
};

export const VISIT_TYPES = [
  { value: "standard", label: "Standard consultation" },
  { value: "long", label: "Long consultation" },
  { value: "telehealth", label: "Telehealth" },
  { value: "vaccination", label: "Vaccination" },
] as const;

export function visitTypeLabel(value: string | null): string {
  return VISIT_TYPES.find((v) => v.value === value)?.label ?? value ?? "Not set";
}

const money = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
export function formatMoney(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : money.format(n);
}

export function personName(p: { first_name: string; last_name: string; preferred_name?: string | null }): string {
  return p.preferred_name ? `${p.first_name} (${p.preferred_name}) ${p.last_name}` : `${p.first_name} ${p.last_name}`;
}

export function clinicianName(c: { first_name: string; last_name: string; clinician_type?: ClinicianType }): string {
  const prefix = c.clinician_type === "nurse" || c.clinician_type === "allied_health" ? "" : "Dr ";
  return `${prefix}${c.first_name} ${c.last_name}`;
}

export function clinicianShortName(c: { first_name: string; last_name: string; clinician_type?: ClinicianType }): string {
  return c.clinician_type === "nurse" || c.clinician_type === "allied_health"
    ? `${c.first_name} ${c.last_name}`
    : `Dr ${c.last_name}`;
}

export function formatRating(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : Number(n).toFixed(1);
}
