// Form validation. Each rule mirrors a `check` constraint (or NOT NULL) in the
// SQL, so the form catches it before the database does.
import { z } from "zod";
import { todayUtc } from "@/lib/time";
import { BLOOD_TYPES, CLAIM_STATUSES, REGISTRATION_STATUSES, SEXES } from "@/types/db";

const optionalText = (max = 200) =>
  z
    .string()
    .trim()
    .max(max, `Keep this under ${max} characters`)
    .transform((v) => (v === "" ? null : v));

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date");
const optionalIsoDate = z
  .string()
  .trim()
  .refine((v) => v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v), "Enter a date")
  .transform((v) => (v === "" ? null : v));

/** "" -> null, otherwise a number (for <input type="number">). */
const optionalNumber = (label: string, min: number, max: number, opts: { int?: boolean } = {}) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => (v === "" || v === null ? null : Number(v)))
    .refine((v) => v === null || Number.isFinite(v), `${label} must be a number`)
    .refine((v) => v === null || !opts.int || Number.isInteger(v), `${label} must be a whole number`)
    .refine((v) => v === null || (v >= min && v <= max), `${label} must be between ${min} and ${max}`);

const money = (label: string) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => (v === "" || v === null ? null : Math.round(Number(v) * 100) / 100))
    .refine((v) => v === null || (Number.isFinite(v) && v >= 0), `${label} can't be negative`);

// --- auth ------------------------------------------------------------------
export const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email address");
export const loginSchema = z.object({ email: emailSchema, password: z.string().min(1, "Enter your password") });
export const passwordSchema = z.string().min(8, "Use at least 8 characters").max(72, "Use 72 characters or fewer");
export const signupSchema = z
  .object({ email: emailSchema, password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Passwords don't match" });
export const totpSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code") });

// --- patients (public.patients) ---------------------------------------------
export const personalSchema = z.object({
  first_name: z.string().trim().min(1, "Enter a first name").max(100),
  last_name: z.string().trim().min(1, "Enter a last name").max(100),
  preferred_name: optionalText(100),
  // check (date_of_birth <= current_date)
  date_of_birth: isoDate.refine((v) => v <= todayUtc(), "Date of birth can't be in the future"),
  // check (sex in ('female','male','intersex','not_stated'))
  sex: z.union([z.enum(SEXES), z.literal("")]).transform((v) => (v === "" ? null : v)),
  gender_identity: optionalText(100),
  email: z
    .string()
    .trim()
    .refine((v) => v === "" || z.string().email().safeParse(v).success, "Enter a valid email address")
    .transform((v) => (v === "" ? null : v.toLowerCase())),
  phone: optionalText(30),
});

export const medicareSchema = z
  .object({
    // check (medicare_number ~ '^\d{10}$')
    medicare_number: z
      .string()
      .transform((v) => v.replace(/\s/g, ""))
      .refine((v) => v === "" || /^\d{10}$/.test(v), "Medicare number is 10 digits")
      .transform((v) => (v === "" ? null : v)),
    // check (medicare_irn between 1 and 9)
    medicare_irn: optionalNumber("IRN", 1, 9, { int: true }),
    medicare_expiry: optionalIsoDate,
    // check (ihi_number ~ '^\d{16}$')
    ihi_number: z
      .string()
      .transform((v) => v.replace(/\s/g, ""))
      .refine((v) => v === "" || /^\d{16}$/.test(v), "IHI is 16 digits")
      .transform((v) => (v === "" ? null : v)),
  })
  .refine((v) => v.medicare_number === null || v.medicare_irn !== null, {
    path: ["medicare_irn"],
    message: "Enter the IRN (the number next to your name on the card)",
  });

export const emergencySchema = z.object({
  emergency_contact_name: optionalText(100),
  emergency_contact_phone: optionalText(30),
  emergency_contact_relationship: optionalText(50),
});

// check (blood_type in (...))
export const bloodTypeSchema = z.object({
  blood_type: z.union([z.enum(BLOOD_TYPES), z.literal("")]).transform((v) => (v === "" ? null : v)),
});

// --- history tables -----------------------------------------------------------
export const addressSchema = z.object({
  address_type: z.enum(["residential", "postal", "billing"]),
  address_line1: z.string().trim().min(1, "Enter the street address").max(200),
  address_line2: optionalText(200),
  suburb: z.string().trim().min(1, "Enter the suburb").max(100),
  state: z.string().trim().min(1, "Choose a state"),
  postcode: z.string().trim().regex(/^\d{4}$/, "Postcode is 4 digits"),
  country: z.string().trim().min(1).default("Australia"),
});

export const residencySchema = z.object({
  residency_status_id: z.string().uuid("Choose a residency status"),
  visa_grant_number: optionalText(50),
});

export const insuranceSchema = z.object({
  provider_id: z.string().uuid("Choose an insurer"),
  plan_id: z.string().uuid("Choose a plan"),
  membership_number: z.string().trim().min(1, "Enter the membership number").max(50),
  is_primary_holder: z.boolean(),
});

// --- visit vitals (20261026020000_visit_vitals.sql) --------------------------
export const vitalsSchema = z
  .object({
    temperature_c: optionalNumber("Temperature", 30, 45),
    spo2_percent: optionalNumber("SpO2", 50, 100, { int: true }),
    bp_systolic: optionalNumber("Systolic", 50, 300, { int: true }),
    bp_diastolic: optionalNumber("Diastolic", 20, 200, { int: true }),
    height_cm: optionalNumber("Height", 30, 250),
    weight_kg: optionalNumber("Weight", 0.5, 400),
    notes: optionalText(1000),
  })
  // check ((bp_systolic is null) = (bp_diastolic is null))
  .refine((v) => (v.bp_systolic === null) === (v.bp_diastolic === null), {
    path: ["bp_diastolic"],
    message: "Enter both systolic and diastolic",
  })
  // check (bp_systolic is null or bp_systolic > bp_diastolic)
  .refine((v) => v.bp_systolic === null || v.bp_diastolic === null || v.bp_systolic > v.bp_diastolic, {
    path: ["bp_systolic"],
    message: "Systolic must be higher than diastolic",
  })
  // check (num_nonnulls(temperature_c, spo2_percent, bp_systolic, height_cm, weight_kg) > 0)
  .refine((v) => [v.temperature_c, v.spo2_percent, v.bp_systolic, v.height_cm, v.weight_kg].some((x) => x !== null), {
    path: ["temperature_c"],
    message: "Enter at least one measurement",
  });

export function bmiPreview(heightCm: number | null, weightKg: number | null): number | null {
  if (!heightCm || !weightKg) return null;
  return Math.round((weightKg / ((heightCm / 100) * (heightCm / 100))) * 10) / 10;
}

// --- ratings (public.clinician_ratings) ---------------------------------------
export const ratingSchema = z.object({
  rating: z.number({ message: "Choose a star rating" }).int().min(1).max(5),
  rating_communication: z.number().int().min(1).max(5).nullable(),
  rating_wait_time: z.number().int().min(1).max(5).nullable(),
  would_recommend: z.boolean().nullable(),
  // check (char_length(comment) <= 2000)
  comment: z
    .string()
    .max(2000, "Keep your comment under 2000 characters")
    .transform((v) => (v.trim() === "" ? null : v.trim())),
  is_anonymous: z.boolean(),
});

// --- appointments ---------------------------------------------------------------
export const feesSchema = z.object({
  fee_charged: money("Fee"),
  medicare_rebate: money("Medicare rebate"),
  gap_amount: money("Gap"),
});

export const notesSchema = z.object({ clinical_notes: z.string().max(10000).transform((v) => (v.trim() === "" ? null : v)) });

export const reasonSchema = z.string().max(500, "Keep this under 500 characters");

// --- clinicians -----------------------------------------------------------------
export const clinicianSchema = z.object({
  first_name: z.string().trim().min(1, "Enter a first name").max(100),
  last_name: z.string().trim().min(1, "Enter a last name").max(100),
  sex: z.union([z.enum(SEXES), z.literal("")]).transform((v) => (v === "" ? null : v)),
  email: z
    .string()
    .trim()
    .refine((v) => v === "" || z.string().email().safeParse(v).success, "Enter a valid email address")
    .transform((v) => (v === "" ? null : v.toLowerCase())),
  phone: optionalText(30),
  clinician_type: z.enum(["gp", "specialist", "nurse", "allied_health"]),
  specialty: optionalText(100),
  // check (ahpra_registration_number ~ '^[A-Z]{3}\d{10}$')
  ahpra_registration_number: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => v === "" || /^[A-Z]{3}\d{10}$/.test(v), "3 letters then 10 digits, e.g. MED0001234567")
    .transform((v) => (v === "" ? null : v)),
  is_active: z.boolean(),
});

export const qualificationSchema = z.object({
  qualification: z.string().trim().min(1, "Enter the qualification").max(100),
  institution: optionalText(200),
  // check (year_awarded between 1900 and 2100)
  year_awarded: optionalNumber("Year", 1900, 2100, { int: true }),
});

export const registrationSchema = z.object({
  status: z.enum(REGISTRATION_STATUSES),
  conditions: optionalText(500),
  valid_from: isoDate,
});

export const affiliationSchema = z
  .object({
    facility_id: z.string().uuid("Choose a clinic"),
    role: optionalText(50),
    // check (medicare_provider_number ~ '^\d{6}[0-9A-Z]{2}$')
    medicare_provider_number: z
      .string()
      .trim()
      .toUpperCase()
      .refine((v) => v === "" || /^\d{6}[0-9A-Z]{2}$/.test(v), "6 digits then 2 letters or digits, e.g. 2451101J")
      .transform((v) => (v === "" ? null : v)),
    valid_from: isoDate,
    valid_to: optionalIsoDate,
  })
  .refine((v) => v.valid_to === null || v.valid_to > v.valid_from, { path: ["valid_to"], message: "End must be after start" });

// --- schedules (clinician_schedules / schedule_exceptions) ----------------------
const time = z.string().regex(/^\d{2}:\d{2}$/, "Enter a time");
export const scheduleSchema = z
  .object({
    clinician_id: z.string().uuid("Choose a clinician"),
    weekday: z.coerce.number().int().min(1).max(7),
    start_time: time,
    end_time: time,
    // check (slot_minutes between 5 and 240)
    slot_minutes: z.coerce.number().int().min(5, "At least 5 minutes").max(240, "At most 240 minutes"),
    valid_from: isoDate,
  })
  // check (end_time > start_time)
  .refine((v) => v.end_time > v.start_time, { path: ["end_time"], message: "End must be after start" });

export const exceptionSchema = z
  .object({
    exception_type: z.enum(["unavailable", "extra_session"]),
    facility_id: z.string(), // "" = all clinics (only for leave)
    start_date: isoDate,
    start_time: time,
    end_date: isoDate,
    end_time: time,
    slot_minutes: optionalNumber("Slot length", 5, 240, { int: true }),
    reason: optionalText(200),
  })
  .refine((v) => `${v.end_date}T${v.end_time}` > `${v.start_date}T${v.start_time}`, {
    path: ["end_time"],
    message: "End must be after start",
  })
  // check (exception_type <> 'extra_session' or (facility_id is not null and slot_minutes is not null))
  .refine((v) => v.exception_type !== "extra_session" || (v.facility_id !== "" && v.slot_minutes !== null), {
    path: ["slot_minutes"],
    message: "Extra sessions need a clinic and a slot length",
  });

// --- claims (public.insurance_claims) -----------------------------------------
export const claimSchema = z.object({
  claim_number: optionalText(50),
  amount_claimed: z.coerce.number().min(0, "Can't be negative"),
  amount_approved: money("Approved amount"),
  amount_paid: money("Paid amount"),
  status: z.enum(CLAIM_STATUSES),
  rejection_reason: optionalText(500),
});

export type PersonalForm = z.input<typeof personalSchema>;
