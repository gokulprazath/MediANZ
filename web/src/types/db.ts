// Hand-written types mirroring the Part A SQL exactly:
//   supabase/migrations/20261026000000_health_booking_schema.sql
//   supabase/migrations/20261026020000_visit_vitals.sql
//   supabase/migrations/20261028100000_chunked_transcription.sql
// Column names and nullability follow the SQL. Postgres `date` is an ISO
// "YYYY-MM-DD" string, `timestamptz` an ISO timestamp string, `numeric` a number.

export type Uuid = string;
export type IsoDate = string;
export type IsoTimestamp = string;

// ---------------------------------------------------------------------------
// 1. Enum types
// ---------------------------------------------------------------------------
export const FACILITY_TYPES = ["hospital", "gp_clinic", "specialist_clinic"] as const;
export type FacilityType = (typeof FACILITY_TYPES)[number];

export const BILLING_POLICIES = ["bulk_billed", "mixed", "private_only"] as const;
export type BillingPolicy = (typeof BILLING_POLICIES)[number];

export const CLINICIAN_TYPES = ["gp", "specialist", "nurse", "allied_health"] as const;
export type ClinicianType = (typeof CLINICIAN_TYPES)[number];

export const RESIDENCY_CATEGORIES = [
  "citizen",
  "permanent_resident",
  "temporary_visa",
  "visitor",
  "other",
] as const;
export type ResidencyCategory = (typeof RESIDENCY_CATEGORIES)[number];

export const INSURANCE_COVER_TYPES = ["hospital", "extras", "combined"] as const;
export type InsuranceCoverType = (typeof INSURANCE_COVER_TYPES)[number];

export const ADDRESS_TYPES = ["residential", "postal", "billing"] as const;
export type AddressType = (typeof ADDRESS_TYPES)[number];

export const REGISTRATION_STATUSES = [
  "registered",
  "registered_with_conditions",
  "suspended",
  "cancelled",
] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export const SLOT_STATUSES = ["available", "held", "booked", "blocked"] as const;
export type SlotStatus = (typeof SLOT_STATUSES)[number];

export const SCHEDULE_EXCEPTION_TYPES = ["unavailable", "extra_session"] as const;
export type ScheduleExceptionType = (typeof SCHEDULE_EXCEPTION_TYPES)[number];

export const APPOINTMENT_STATUSES = [
  "booked",
  "confirmed",
  "checked_in",
  "in_consultation",
  "completed",
  "cancelled",
  "no_show",
  "rescheduled",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const BOOKING_CHANNELS = ["web", "mobile", "phone", "reception"] as const;
export type BookingChannel = (typeof BOOKING_CHANNELS)[number];

export const CLAIM_STATUSES = ["draft", "submitted", "approved", "rejected", "paid"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const CONSENT_PARTIES = ["patient", "clinician"] as const;
export type ConsentParty = (typeof CONSENT_PARTIES)[number];

export const CONSENT_METHODS = ["in_app", "verbal_recorded", "written"] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];

export const RECORDING_STATUSES = [
  "started",
  "awaiting_review",
  "approved",
  "rejected",
  "expired",
  "failed",
  "consent_withdrawn",
] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

export const TRANSCRIPT_STATUSES = ["pending_patient_review", "approved"] as const;
export type TranscriptStatus = (typeof TRANSCRIPT_STATUSES)[number];

export const MODERATION_STATUSES = ["visible", "hidden", "flagged"] as const;
export type ModerationStatus = (typeof MODERATION_STATUSES)[number];

// Text columns with a `check (... in (...))` constraint.
export const SEXES = ["female", "male", "intersex", "not_stated"] as const;
export type Sex = (typeof SEXES)[number];

export const BLOOD_TYPES = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"] as const;
export type BloodType = (typeof BLOOD_TYPES)[number];

export const PLAN_TIERS = ["gold", "silver", "bronze", "basic"] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

// ---------------------------------------------------------------------------
// 3. Reference tables
// ---------------------------------------------------------------------------
export interface ResidencyStatus {
  id: Uuid;
  code: string;
  category: ResidencyCategory;
  visa_subclass: string | null;
  name: string;
  medicare_eligible: boolean;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface InsuranceProvider {
  id: Uuid;
  name: string;
  phone: string | null;
  website: string | null;
  is_active: boolean;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface InsurancePlan {
  id: Uuid;
  provider_id: Uuid;
  plan_name: string;
  cover_type: InsuranceCoverType;
  tier: PlanTier | null;
  is_active: boolean;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// 4. Patients (+ history)
// ---------------------------------------------------------------------------
export interface Patient {
  id: Uuid;
  auth_user_id: Uuid | null;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  date_of_birth: IsoDate;
  sex: Sex | null;
  gender_identity: string | null;
  email: string | null;
  phone: string | null;
  blood_type: BloodType | null;
  medicare_number: string | null;
  medicare_irn: number | null;
  medicare_expiry: IsoDate | null;
  ihi_number: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  is_active: boolean;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export type PatientInsert = Pick<Patient, "first_name" | "last_name" | "date_of_birth"> &
  Partial<
    Omit<Patient, "id" | "created_at" | "updated_at" | "first_name" | "last_name" | "date_of_birth">
  >;

export type PatientUpdate = Partial<Omit<Patient, "id" | "auth_user_id" | "created_at" | "updated_at">>;

export interface PatientAddress {
  id: Uuid;
  patient_id: Uuid;
  address_type: AddressType;
  address_line1: string;
  address_line2: string | null;
  suburb: string;
  state: string;
  postcode: string;
  country: string;
  valid_from: IsoDate;
  valid_to: IsoDate | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export type AddressInput = Pick<
  PatientAddress,
  "address_type" | "address_line1" | "address_line2" | "suburb" | "state" | "postcode" | "country"
>;

export interface PatientResidency {
  id: Uuid;
  patient_id: Uuid;
  residency_status_id: Uuid;
  visa_grant_number: string | null;
  valid_from: IsoDate;
  valid_to: IsoDate | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export type ResidencyInput = Pick<PatientResidency, "residency_status_id" | "visa_grant_number">;

export interface PatientInsurancePolicy {
  id: Uuid;
  patient_id: Uuid;
  plan_id: Uuid;
  membership_number: string;
  is_primary_holder: boolean;
  valid_from: IsoDate;
  valid_to: IsoDate | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export type PolicyInput = Pick<PatientInsurancePolicy, "plan_id" | "membership_number" | "is_primary_holder">;

// ---------------------------------------------------------------------------
// 5. Facilities (+ history)
// ---------------------------------------------------------------------------
export interface Facility {
  id: Uuid;
  name: string;
  facility_type: FacilityType;
  abn: string | null;
  phone: string | null;
  email: string | null;
  address_line1: string;
  address_line2: string | null;
  suburb: string;
  state: string;
  postcode: string;
  country: string;
  timezone: string;
  latitude: number | null;
  longitude: number | null;
  is_active: boolean;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface FacilityBillingPolicy {
  id: Uuid;
  facility_id: Uuid;
  billing_policy: BillingPolicy;
  notes: string | null;
  valid_from: IsoDate;
  valid_to: IsoDate | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// 6. Clinicians (+ history)
// ---------------------------------------------------------------------------
export interface Clinician {
  id: Uuid;
  auth_user_id: Uuid | null;
  first_name: string;
  last_name: string;
  sex: Sex | null;
  email: string | null;
  phone: string | null;
  clinician_type: ClinicianType;
  specialty: string | null;
  ahpra_registration_number: string | null;
  is_active: boolean;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export type ClinicianInput = Pick<Clinician, "first_name" | "last_name"> &
  Partial<
    Pick<
      Clinician,
      | "sex"
      | "email"
      | "phone"
      | "clinician_type"
      | "specialty"
      | "ahpra_registration_number"
      | "is_active"
    >
  >;

export interface ClinicianQualification {
  id: Uuid;
  clinician_id: Uuid;
  qualification: string;
  institution: string | null;
  year_awarded: number | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface ClinicianRegistration {
  id: Uuid;
  clinician_id: Uuid;
  status: RegistrationStatus;
  conditions: string | null;
  valid_from: IsoDate;
  valid_to: IsoDate | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface ClinicianAffiliation {
  id: Uuid;
  clinician_id: Uuid;
  facility_id: Uuid;
  role: string | null;
  medicare_provider_number: string | null;
  valid_from: IsoDate;
  valid_to: IsoDate | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// 7. Booking: schedules, exceptions, slots
// ---------------------------------------------------------------------------
export interface ClinicianSchedule {
  id: Uuid;
  clinician_id: Uuid;
  facility_id: Uuid;
  weekday: number; // 1 = Monday ... 7 = Sunday (ISO)
  start_time: string; // "HH:MM:SS"
  end_time: string;
  slot_minutes: number;
  valid_from: IsoDate;
  valid_to: IsoDate | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface ScheduleException {
  id: Uuid;
  clinician_id: Uuid;
  facility_id: Uuid | null;
  exception_type: ScheduleExceptionType;
  starts_at: IsoTimestamp;
  ends_at: IsoTimestamp;
  slot_minutes: number | null;
  reason: string | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export type ScheduleExceptionInput = Pick<
  ScheduleException,
  "clinician_id" | "facility_id" | "exception_type" | "starts_at" | "ends_at" | "slot_minutes" | "reason"
>;

export interface AppointmentSlot {
  id: Uuid;
  clinician_id: Uuid;
  facility_id: Uuid;
  starts_at: IsoTimestamp;
  ends_at: IsoTimestamp;
  status: SlotStatus;
  held_by_patient_id: Uuid | null;
  held_until: IsoTimestamp | null;
  source_schedule_id: Uuid | null;
  source_exception_id: Uuid | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// 8. Appointments and status history
// ---------------------------------------------------------------------------
export interface Appointment {
  id: Uuid;
  slot_id: Uuid;
  patient_id: Uuid;
  clinician_id: Uuid;
  facility_id: Uuid;
  clinician_affiliation_id: Uuid;
  patient_insurance_policy_id: Uuid | null;
  scheduled_start: IsoTimestamp;
  scheduled_end: IsoTimestamp;
  status: AppointmentStatus;
  visit_type: string | null;
  reason: string | null;
  booking_channel: BookingChannel;
  booked_at: IsoTimestamp;
  booked_by: Uuid | null;
  confirmed_at: IsoTimestamp | null;
  reminder_sent_at: IsoTimestamp | null;
  checked_in_at: IsoTimestamp | null;
  consult_started_at: IsoTimestamp | null;
  consult_ended_at: IsoTimestamp | null;
  no_show_marked_at: IsoTimestamp | null;
  cancelled_at: IsoTimestamp | null;
  cancelled_by: Uuid | null;
  cancellation_reason: string | null;
  rescheduled_to_appointment_id: Uuid | null;
  clinical_notes: string | null;
  fee_charged: number | null;
  medicare_rebate: number | null;
  gap_amount: number | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

// What clinicians and staff may change on an appointment row (RLS "update:
// clinician or staff"; the trigger rejects changes to the booking facts).
export type AppointmentUpdate = Partial<
  Pick<Appointment, "status" | "clinical_notes" | "fee_charged" | "medicare_rebate" | "gap_amount">
>;

export interface AppointmentStatusHistory {
  id: number;
  appointment_id: Uuid;
  from_status: AppointmentStatus | null;
  to_status: AppointmentStatus;
  changed_at: IsoTimestamp;
  changed_by: Uuid | null;
}

// ---------------------------------------------------------------------------
// 9. Insurance claims
// ---------------------------------------------------------------------------
export interface InsuranceClaim {
  id: Uuid;
  appointment_id: Uuid;
  patient_insurance_policy_id: Uuid;
  claim_number: string | null;
  amount_claimed: number;
  amount_approved: number | null;
  amount_paid: number | null;
  status: ClaimStatus;
  submitted_at: IsoTimestamp | null;
  processed_at: IsoTimestamp | null;
  rejection_reason: string | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export type ClaimInsert = Pick<InsuranceClaim, "appointment_id" | "amount_claimed"> &
  Partial<Pick<InsuranceClaim, "claim_number" | "status">>;

export type ClaimUpdate = Partial<
  Pick<
    InsuranceClaim,
    "claim_number" | "amount_claimed" | "amount_approved" | "amount_paid" | "status" | "rejection_reason"
  >
>;

// ---------------------------------------------------------------------------
// 10. Recording consent, sessions and transcripts
// ---------------------------------------------------------------------------
export interface RecordingConsent {
  id: Uuid;
  appointment_id: Uuid;
  party: ConsentParty;
  patient_id: Uuid | null;
  clinician_id: Uuid | null;
  consent_given: boolean;
  consent_text_version: string;
  method: ConsentMethod;
  given_at: IsoTimestamp;
  withdrawn_at: IsoTimestamp | null;
  withdrawal_reason: string | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface RecordingSession {
  id: Uuid;
  appointment_id: Uuid;
  started_by: Uuid;
  started_at: IsoTimestamp;
  ended_at: IsoTimestamp | null;
  duration_seconds: number | null;
  engine: string | null;
  engine_model: string | null;
  status: RecordingStatus;
  audio_discarded_at: IsoTimestamp | null;
  error_message: string | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface TranscriptSegment {
  speaker: string;
  start_sec: number;
  end_sec: number;
  text: string;
  chunk?: number;
}

export interface ConsultTranscript {
  id: Uuid;
  recording_session_id: Uuid;
  appointment_id: Uuid;
  transcript_text: string;
  segments: TranscriptSegment[] | null;
  summary_text: string | null;
  language: string;
  status: TranscriptStatus;
  review_expires_at: IsoTimestamp;
  approved_at: IsoTimestamp | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// 11. Clinician ratings
// ---------------------------------------------------------------------------
export interface ClinicianRating {
  id: Uuid;
  appointment_id: Uuid;
  patient_id: Uuid;
  clinician_id: Uuid;
  rating: number;
  rating_communication: number | null;
  rating_wait_time: number | null;
  would_recommend: boolean | null;
  comment: string | null;
  is_anonymous: boolean;
  moderation_status: ModerationStatus;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export type RatingInput = Pick<
  ClinicianRating,
  "rating" | "rating_communication" | "rating_wait_time" | "would_recommend" | "comment" | "is_anonymous"
>;

// ---------------------------------------------------------------------------
// Visit vitals (20261026020000_visit_vitals.sql)
// ---------------------------------------------------------------------------
export interface VisitVitals {
  id: Uuid;
  appointment_id: Uuid;
  patient_id: Uuid;
  temperature_c: number | null;
  spo2_percent: number | null;
  bp_systolic: number | null;
  bp_diastolic: number | null;
  height_cm: number | null;
  weight_kg: number | null;
  bmi: number | null; // generated column
  notes: string | null;
  recorded_at: IsoTimestamp;
  recorded_by: Uuid | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export type VitalsInput = Pick<
  VisitVitals,
  "temperature_c" | "spo2_percent" | "bp_systolic" | "bp_diastolic" | "height_cm" | "weight_kg" | "notes"
>;

export interface VisitVitalsLatest {
  appointment_id: Uuid;
  patient_id: Uuid;
  visit_start: IsoTimestamp;
  temperature_c: number | null;
  spo2_percent: number | null;
  bp_systolic: number | null;
  bp_diastolic: number | null;
  height_cm: number | null;
  weight_kg: number | null;
  bmi: number | null;
  last_recorded_at: IsoTimestamp | null;
}

// ---------------------------------------------------------------------------
// RPC return types
// ---------------------------------------------------------------------------
// get_available_slots(p_date, p_facility_id, p_clinician_id, p_clinician_type)
export interface AvailableSlot {
  slot_id: Uuid;
  starts_at: IsoTimestamp;
  ends_at: IsoTimestamp;
  local_start: string; // timestamp without time zone, facility wall clock
  clinician_id: Uuid;
  clinician_name: string;
  clinician_type: ClinicianType;
  specialty: string | null;
  facility_id: Uuid;
  facility_name: string;
  facility_tz: string;
}

// get_clinician_rating_summary(p_clinician_id)
export interface ClinicianRatingSummary {
  clinician_id: Uuid;
  rating_count: number;
  avg_rating: number | null;
  avg_communication: number | null;
  avg_wait_time: number | null;
  pct_would_recommend: number | null;
}

// get_my_ratings_as_clinician()
export interface MyClinicianRating {
  rating_id: Uuid;
  appointment_id: Uuid;
  visit_date: IsoTimestamp;
  rating: number;
  rating_communication: number | null;
  rating_wait_time: number | null;
  would_recommend: boolean | null;
  comment: string | null;
  patient_display_name: string | null; // null when anonymous
  created_at: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Joined shapes the app reads (PostgREST embeds)
// ---------------------------------------------------------------------------
export type PatientSummary = Pick<
  Patient,
  "id" | "first_name" | "last_name" | "preferred_name" | "date_of_birth" | "sex" | "phone" | "email"
>;
export type ClinicianSummary = Pick<
  Clinician,
  "id" | "first_name" | "last_name" | "clinician_type" | "specialty"
>;
export type FacilitySummary = Pick<
  Facility,
  "id" | "name" | "timezone" | "address_line1" | "suburb" | "state" | "postcode" | "phone"
>;

export interface AppointmentWithRefs extends Appointment {
  patient: PatientSummary | null; // null when RLS hides the patient row
  clinician: ClinicianSummary;
  facility: FacilitySummary;
}

export const PATIENT_SUMMARY_COLUMNS =
  "id,first_name,last_name,preferred_name,date_of_birth,sex,phone,email";
export const CLINICIAN_SUMMARY_COLUMNS = "id,first_name,last_name,clinician_type,specialty";
export const FACILITY_SUMMARY_COLUMNS = "id,name,timezone,address_line1,suburb,state,postcode,phone";
