// The mock database, built from supabase/seed/01_sample_data.sql,
// 02_link_test_logins.sql and 03_sample_vitals.sql: the same ids, names and
// values, with dates relative to today exactly as the SQL computes them.
// Rows the SQL creates with gen_random_uuid() get stable generated ids here.
import { validOn } from "@/lib/history";
import { addDays, isoDow, localDate, todayUtc, zonedToUtc } from "@/lib/time";
import type {
  Appointment,
  AppointmentSlot,
  AppointmentStatus,
  AppointmentStatusHistory,
  BookingChannel,
  Clinician,
  ClinicianAffiliation,
  ClinicianQualification,
  ClinicianRating,
  ClinicianRegistration,
  ClinicianSchedule,
  ConsultTranscript,
  Facility,
  FacilityBillingPolicy,
  InsuranceClaim,
  InsurancePlan,
  InsuranceProvider,
  IsoDate,
  ModerationStatus,
  Patient,
  PatientAddress,
  PatientInsurancePolicy,
  PatientResidency,
  RecordingConsent,
  RecordingSession,
  RecordingStatus,
  ResidencyStatus,
  ScheduleException,
  TranscriptSegment,
  Uuid,
  VisitVitals,
} from "@/types/db";
import { emptyAgentLayer, runMockConsultWorker, seedResearchDrafts, type AgentLayerState } from "./agent-layer";
import { seedUsers, type MockUser } from "./users";

export interface ChunkRow {
  session_id: Uuid;
  seq: number;
  transcript_text: string;
  segments: TranscriptSegment[] | null;
  duration_seconds: number | null;
  engine: string | null;
  engine_model: string | null;
  created_at: string;
}

export interface MockState {
  users: MockUser[];
  residency_statuses: ResidencyStatus[];
  insurance_providers: InsuranceProvider[];
  insurance_plans: InsurancePlan[];
  facilities: Facility[];
  facility_billing_policies: FacilityBillingPolicy[];
  clinicians: Clinician[];
  clinician_qualifications: ClinicianQualification[];
  clinician_registrations: ClinicianRegistration[];
  clinician_affiliations: ClinicianAffiliation[];
  clinician_schedules: ClinicianSchedule[];
  schedule_exceptions: ScheduleException[];
  patients: Patient[];
  patient_addresses: PatientAddress[];
  patient_residency: PatientResidency[];
  patient_insurance_policies: PatientInsurancePolicy[];
  appointment_slots: AppointmentSlot[];
  appointments: Appointment[];
  appointment_status_history: AppointmentStatusHistory[];
  insurance_claims: InsuranceClaim[];
  recording_consents: RecordingConsent[];
  recording_sessions: RecordingSession[];
  recording_session_chunks: ChunkRow[];
  consult_transcripts: ConsultTranscript[];
  clinician_ratings: ClinicianRating[];
  visit_vitals: VisitVitals[];
  agent: AgentLayerState; // agent layer and Part B (see agent-layer.ts)
  counters: Record<string, number>;
}

// Stable ids for rows the SQL creates with gen_random_uuid().
export function nextId(state: MockState, prefix: string): Uuid {
  const n = (state.counters[prefix] = (state.counters[prefix] ?? 0) + 1);
  return `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export function nextSerial(state: MockState, name: string): number {
  return (state.counters[name] = (state.counters[name] ?? 0) + 1);
}

export const ID_PREFIX = {
  billing: "32000000",
  qualification: "41000000",
  registration: "42000000",
  affiliation: "43000000",
  schedule: "44000000",
  exception: "45000000",
  address: "52000000",
  residency: "53000000",
  slot: "62000000",
  consent: "72000000",
  rating: "80000000",
  claim: "81000000",
  vitals: "82000000",
} as const;

const ts = (d: Date) => d.toISOString();
const plusMin = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

// ---------------------------------------------------------------------------
// Validity-range helpers used by both the seed and the store
// ---------------------------------------------------------------------------
export { validOn };

export function affiliationOn(state: MockState, clinicianId: Uuid, facilityId: Uuid, day: IsoDate) {
  return (
    state.clinician_affiliations.find(
      (a) => a.clinician_id === clinicianId && a.facility_id === facilityId && validOn(a, day),
    ) ?? null
  );
}

export function policyOn(state: MockState, patientId: Uuid, day: IsoDate) {
  return state.patient_insurance_policies.find((p) => p.patient_id === patientId && validOn(p, day)) ?? null;
}

export function facilityTz(state: MockState, facilityId: Uuid): string {
  return state.facilities.find((f) => f.id === facilityId)?.timezone ?? "Australia/Brisbane";
}

function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd;
}

// ---------------------------------------------------------------------------
// public.sync_slot_blocks / public.generate_slots
// ---------------------------------------------------------------------------
export function syncSlotBlocks(state: MockState, clinicianId: Uuid | null, now: Date): void {
  const nowIso = ts(now);
  const onLeave = (s: AppointmentSlot) =>
    state.schedule_exceptions.some(
      (e) =>
        e.exception_type === "unavailable" &&
        e.clinician_id === s.clinician_id &&
        (e.facility_id === null || e.facility_id === s.facility_id) &&
        overlaps(e.starts_at, e.ends_at, s.starts_at, s.ends_at),
    );
  for (const s of state.appointment_slots) {
    if (s.starts_at <= nowIso || (clinicianId && s.clinician_id !== clinicianId)) continue;
    if ((s.status === "available" || s.status === "held") && onLeave(s)) {
      Object.assign(s, { status: "blocked", held_by_patient_id: null, held_until: null, updated_at: nowIso });
    }
  }
  for (const s of state.appointment_slots) {
    if (s.starts_at <= nowIso || (clinicianId && s.clinician_id !== clinicianId)) continue;
    if (
      s.status === "blocked" &&
      !onLeave(s) &&
      !state.appointments.some((a) => a.slot_id === s.id && a.status !== "cancelled" && a.status !== "rescheduled")
    ) {
      Object.assign(s, { status: "available", updated_at: nowIso });
    }
  }
}

function insertSlotIfFree(
  state: MockState,
  slot: Omit<AppointmentSlot, "id" | "created_at" | "updated_at" | "status" | "held_by_patient_id" | "held_until">,
  now: Date,
): boolean {
  // exclude using gist (clinician_id with =, tstzrange(starts_at, ends_at) with &&) ... on conflict do nothing
  const clash = state.appointment_slots.some(
    (s) => s.clinician_id === slot.clinician_id && overlaps(s.starts_at, s.ends_at, slot.starts_at, slot.ends_at),
  );
  if (clash) return false;
  state.appointment_slots.push({
    id: nextId(state, ID_PREFIX.slot),
    status: "available",
    held_by_patient_id: null,
    held_until: null,
    created_at: ts(now),
    updated_at: ts(now),
    ...slot,
  });
  return true;
}

export function generateSlots(state: MockState, from: IsoDate, to: IsoDate, now: Date): number {
  let created = 0;
  const nowIso = ts(now);
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const dow = isoDow(day);
    for (const s of state.clinician_schedules) {
      if (s.weekday !== dow || day < s.valid_from || (s.valid_to !== null && day >= s.valid_to)) continue;
      const facility = state.facilities.find((f) => f.id === s.facility_id && f.is_active);
      const clinician = state.clinicians.find((c) => c.id === s.clinician_id && c.is_active);
      if (!facility || !clinician || !affiliationOn(state, s.clinician_id, s.facility_id, day)) continue;
      const winStart = zonedToUtc(day, s.start_time, facility.timezone);
      const winEnd = zonedToUtc(day, s.end_time, facility.timezone);
      for (let t = winStart; plusMin(t, s.slot_minutes) <= winEnd; t = plusMin(t, s.slot_minutes)) {
        if (ts(t) <= nowIso) continue;
        if (
          insertSlotIfFree(
            state,
            {
              clinician_id: s.clinician_id,
              facility_id: s.facility_id,
              starts_at: ts(t),
              ends_at: ts(plusMin(t, s.slot_minutes)),
              source_schedule_id: s.id,
              source_exception_id: null,
            },
            now,
          )
        )
          created++;
      }
    }
  }
  for (const e of state.schedule_exceptions) {
    if (e.exception_type !== "extra_session" || !e.facility_id || !e.slot_minutes) continue;
    if (e.starts_at.slice(0, 10) > addDays(to, 1) || e.ends_at.slice(0, 10) < addDays(from, -1)) continue;
    const start = new Date(e.starts_at);
    const end = new Date(e.ends_at);
    for (let t = start; plusMin(t, e.slot_minutes) <= end; t = plusMin(t, e.slot_minutes)) {
      if (ts(t) <= nowIso) continue;
      if (
        insertSlotIfFree(
          state,
          {
            clinician_id: e.clinician_id,
            facility_id: e.facility_id,
            starts_at: ts(t),
            ends_at: ts(plusMin(t, e.slot_minutes)),
            source_schedule_id: null,
            source_exception_id: e.id,
          },
          now,
        )
      )
        created++;
    }
  }
  syncSlotBlocks(state, null, now);
  return created;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------
const REF = (n: number, prefix: string) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const RS = (n: number) => REF(n, "10000000");
const PROV = (n: number) => REF(n, "20000000");
const PLAN = (n: number) => REF(n, "21000000");
export const FAC = (n: number) => REF(n, "30000000");
export const CLIN = (n: number) => REF(n, "40000000");
export const PAT = (n: number) => REF(n, "50000000");
const POL = (n: number) => REF(n, "51000000");
export const APPT = (n: number) => REF(n, "60000000");
const SLOT = (n: number) => REF(n, "61000000");
const SESS = (n: number) => REF(n, "70000000");
const TRANS = (n: number) => REF(n, "71000000");

export const SEED_IDS = { RS, PROV, PLAN, FAC, CLIN, PAT, POL, APPT, SLOT, SESS, TRANS };

export function buildSeed(now: Date = new Date()): MockState {
  const today = todayUtc(now);
  const nowIso = ts(now);
  const stamp = { created_at: nowIso, updated_at: nowIso };
  const d = (offset: number) => addDays(today, offset);

  const state: MockState = {
    users: seedUsers(),
    residency_statuses: [],
    insurance_providers: [],
    insurance_plans: [],
    facilities: [],
    facility_billing_policies: [],
    clinicians: [],
    clinician_qualifications: [],
    clinician_registrations: [],
    clinician_affiliations: [],
    clinician_schedules: [],
    schedule_exceptions: [],
    patients: [],
    patient_addresses: [],
    patient_residency: [],
    patient_insurance_policies: [],
    appointment_slots: [],
    appointments: [],
    appointment_status_history: [],
    insurance_claims: [],
    recording_consents: [],
    recording_sessions: [],
    recording_session_chunks: [],
    consult_transcripts: [],
    clinician_ratings: [],
    visit_vitals: [],
    agent: emptyAgentLayer(),
    counters: {},
  };

  // 1. Residency statuses
  const rs: [string, ResidencyStatus["category"], string | null, string, boolean][] = [
    ["AU_CITIZEN", "citizen", null, "Australian citizen", true],
    ["PR_189", "permanent_resident", "189", "Skilled Independent visa", true],
    ["NZ_444", "temporary_visa", "444", "Special Category visa (NZ citizen)", true],
    ["VISA_500", "temporary_visa", "500", "Student visa", false],
    ["VISA_482", "temporary_visa", "482", "Skills in Demand visa", false],
    ["VISA_600", "visitor", "600", "Visitor visa", false],
    ["VISA_820", "temporary_visa", "820", "Partner visa (temporary)", true],
    ["VISA_485", "temporary_visa", "485", "Temporary Graduate visa", false],
  ];
  state.residency_statuses = rs.map(([code, category, visa_subclass, name, medicare_eligible], i) => ({
    id: RS(i + 1),
    code,
    category,
    visa_subclass,
    name,
    medicare_eligible,
    ...stamp,
  }));

  // 2. Insurance providers and plans
  const prov: [string, string, string][] = [
    ["Sunstate Health Fund", "07 5550 0201", "https://sunstate.example.com"],
    ["Harbourside Health", "02 5550 0202", "https://harbourside.example.com"],
    ["Campus Cover OSHC", "07 5550 0203", "https://campuscover.example.com"],
    ["Wanderer Visitor Cover", "07 5550 0204", "https://wanderer.example.com"],
  ];
  state.insurance_providers = prov.map(([name, phone, website], i) => ({
    id: PROV(i + 1),
    name,
    phone,
    website,
    is_active: true,
    ...stamp,
  }));
  const plans: [number, string, InsurancePlan["cover_type"], InsurancePlan["tier"]][] = [
    [1, "Gold Hospital", "hospital", "gold"],
    [1, "Silver Plus Combined", "combined", "silver"],
    [2, "Bronze Hospital", "hospital", "bronze"],
    [2, "Basic Extras", "extras", "basic"],
    [3, "OSHC Essentials", "combined", null],
    [4, "Visitor Standard", "combined", null],
  ];
  state.insurance_plans = plans.map(([p, plan_name, cover_type, tier], i) => ({
    id: PLAN(i + 1),
    provider_id: PROV(p),
    plan_name,
    cover_type,
    tier,
    is_active: true,
    ...stamp,
  }));

  // 3. Facilities
  const fac: [string, Facility["facility_type"], string, string, string, string, string, string, string, string, number, number][] = [
    ["Southbank Family Medical", "gp_clinic", "51824753556", "07 5550 0101", "reception@southbank-fm.example.com", "123 Grey Street", "South Brisbane", "QLD", "4101", "Australia/Brisbane", -27.4775, 153.0208],
    ["Paddington GP Clinic", "gp_clinic", "62835984177", "07 5550 0102", "hello@paddington-gp.example.com", "45 Given Terrace", "Paddington", "QLD", "4064", "Australia/Brisbane", -27.4604, 153.0033],
    ["Kedron Valley Private Hospital", "hospital", "73846195288", "07 5550 0103", "admissions@kvph.example.com", "200 Gympie Road", "Chermside", "QLD", "4032", "Australia/Brisbane", -27.3856, 153.0312],
    ["Riverside Medical Parramatta", "gp_clinic", "84857206399", "02 5550 0104", "frontdesk@riverside-med.example.com", "10 Church Street", "Parramatta", "NSW", "2150", "Australia/Sydney", -33.815, 151.0035],
  ];
  state.facilities = fac.map(
    ([name, facility_type, abn, phone, email, address_line1, suburb, st, postcode, timezone, latitude, longitude], i) => ({
      id: FAC(i + 1),
      name,
      facility_type,
      abn,
      phone,
      email,
      address_line1,
      address_line2: null,
      suburb,
      state: st,
      postcode,
      country: "Australia",
      timezone,
      latitude,
      longitude,
      is_active: true,
      ...stamp,
    }),
  );

  const billing: [number, FacilityBillingPolicy["billing_policy"], string | null, IsoDate, IsoDate | null][] = [
    [1, "bulk_billed", "Bulk billing for all patients", "2022-01-01", d(-180)],
    [1, "mixed", "Bulk billing for concession card holders and under 16s only", d(-180), null],
    [2, "mixed", null, "2021-01-01", null],
    [3, "private_only", null, "2020-01-01", null],
    [4, "bulk_billed", null, "2023-01-01", null],
  ];
  for (const [f, billing_policy, notes, valid_from, valid_to] of billing) {
    state.facility_billing_policies.push({
      id: nextId(state, ID_PREFIX.billing),
      facility_id: FAC(f),
      billing_policy,
      notes,
      valid_from,
      valid_to,
      ...stamp,
    });
  }

  // 4. Clinicians, qualifications, registrations, affiliations
  const clin: [string, string, Clinician["sex"], string, string, Clinician["clinician_type"], string, string][] = [
    ["Asha", "Rao", "female", "asha.rao@example.com", "0491 570 101", "gp", "General Practice", "MED0001100001"],
    ["Liam", "Nguyen", "male", "liam.nguyen@example.com", "0491 570 102", "gp", "General Practice", "MED0001100002"],
    ["Sophie", "Williams", "female", "sophie.williams@example.com", "0491 570 103", "gp", "General Practice", "MED0001100003"],
    ["Mateo", "Garcia", "male", "mateo.garcia@example.com", "0491 570 104", "specialist", "Dermatology", "MED0001100004"],
    ["Hannah", "Kim", "female", "hannah.kim@example.com", "0491 570 105", "gp", "General Practice", "MED0001100005"],
    ["Grace", "O'Connor", "female", "grace.oconnor@example.com", "0491 570 106", "nurse", "Practice Nursing", "NMW0001100006"],
  ];
  state.clinicians = clin.map(([first_name, last_name, sex, email, phone, clinician_type, specialty, ahpra], i) => ({
    id: CLIN(i + 1),
    auth_user_id: null,
    first_name,
    last_name,
    sex,
    email,
    phone,
    clinician_type,
    specialty,
    ahpra_registration_number: ahpra,
    is_active: true,
    ...stamp,
  }));

  const quals: [number, string, string, number][] = [
    [1, "MBBS", "University of Queensland", 2009],
    [1, "FRACGP", "Royal Australian College of General Practitioners", 2014],
    [2, "MD", "Griffith University", 2012],
    [2, "FRACGP", "Royal Australian College of General Practitioners", 2017],
    [3, "MBBS", "James Cook University", 2006],
    [3, "FRACGP", "Royal Australian College of General Practitioners", 2011],
    [4, "MBBS", "University of Sydney", 2004],
    [4, "FACD", "Australasian College of Dermatologists", 2012],
    [5, "MD", "University of New South Wales", 2015],
    [5, "FRACGP", "Royal Australian College of General Practitioners", 2020],
    [6, "BNurs", "Queensland University of Technology", 2013],
  ];
  for (const [c, qualification, institution, year_awarded] of quals) {
    state.clinician_qualifications.push({
      id: nextId(state, ID_PREFIX.qualification),
      clinician_id: CLIN(c),
      qualification,
      institution,
      year_awarded,
      ...stamp,
    });
  }

  const regs: [number, ClinicianRegistration["status"], string | null, IsoDate, IsoDate | null][] = [
    [1, "registered", null, "2010-01-01", null],
    [2, "registered", null, "2013-01-01", null],
    [3, "registered_with_conditions", "Must practise under supervision for 12 months", "2023-07-01", "2024-07-01"],
    [3, "registered", null, "2024-07-01", null],
    [4, "registered", null, "2005-01-01", null],
    [5, "registered", null, "2016-01-01", null],
    [6, "registered", null, "2014-01-01", null],
  ];
  for (const [c, status, conditions, valid_from, valid_to] of regs) {
    state.clinician_registrations.push({
      id: nextId(state, ID_PREFIX.registration),
      clinician_id: CLIN(c),
      status,
      conditions,
      valid_from,
      valid_to,
      ...stamp,
    });
  }

  const affs: [number, number, string, string | null, IsoDate, IsoDate | null][] = [
    [1, 2, "GP", "2451101J", "2019-01-01", d(-90)],
    [1, 1, "GP", "2451102K", d(-90), null],
    [2, 1, "GP", "2451201A", "2022-02-01", null],
    [2, 2, "GP", "2451202B", "2022-02-01", null],
    [3, 2, "GP", "2451301C", "2018-03-01", null],
    [4, 3, "VMO", "2451401D", "2016-05-01", null],
    [5, 4, "GP", "2451501E", "2020-08-01", null],
    [6, 1, "Practice nurse", null, "2021-04-01", null],
  ];
  for (const [c, f, role, medicare_provider_number, valid_from, valid_to] of affs) {
    state.clinician_affiliations.push({
      id: nextId(state, ID_PREFIX.affiliation),
      clinician_id: CLIN(c),
      facility_id: FAC(f),
      role,
      medicare_provider_number,
      valid_from,
      valid_to,
      ...stamp,
    });
  }

  // 5. Weekly schedules
  const sched: [number, number, number[], string, string, number, IsoDate, IsoDate | null][] = [
    [1, 2, [1, 2, 3, 4, 5], "08:30:00", "12:30:00", 15, "2024-01-01", d(-90)],
    [1, 1, [1, 2, 3, 4, 5], "08:30:00", "12:30:00", 15, d(-90), null],
    [2, 1, [1, 3, 5], "13:00:00", "17:00:00", 15, "2024-01-01", null],
    [2, 2, [2, 4], "09:00:00", "13:00:00", 15, "2024-01-01", null],
    [3, 2, [1, 2, 3, 4, 5], "09:00:00", "12:00:00", 20, "2024-01-01", null],
    [4, 3, [2, 4], "09:00:00", "12:00:00", 30, "2024-01-01", null],
    [5, 4, [1, 2, 3, 4, 5], "09:00:00", "12:00:00", 15, "2024-01-01", null],
    [6, 1, [1, 2, 3, 4, 5], "09:00:00", "11:00:00", 30, "2024-01-01", null],
  ];
  for (const [c, f, days, start_time, end_time, slot_minutes, valid_from, valid_to] of sched) {
    for (const weekday of days) {
      state.clinician_schedules.push({
        id: nextId(state, ID_PREFIX.schedule),
        clinician_id: CLIN(c),
        facility_id: FAC(f),
        weekday,
        start_time,
        end_time,
        slot_minutes,
        valid_from,
        valid_to,
        ...stamp,
      });
    }
  }

  // 6. Patients and their history
  const pats: [string, string, string | null, IsoDate, Patient["sex"], string, string | null, Patient["blood_type"], string | null, number | null, IsoDate | null, string | null, string, string, string][] = [
    ["Olivia", "Brown", "Liv", "1988-03-14", "female", "olivia.brown@example.com", "0491 570 201", "O+", "2953176541", 1, "2029-06-30", "8003608166690503", "James Brown", "0491 570 211", "Husband"],
    ["Jack", "Wilson", null, "1975-11-02", "male", "jack.wilson@example.com", "0491 570 202", "A-", "3164287652", 1, "2028-02-28", null, "Karen Wilson", "0491 570 212", "Wife"],
    ["Priya", "Sharma", null, "2001-07-21", "female", "priya.sharma@example.com", "0491 570 203", "B+", null, null, null, null, "Anil Sharma", "+91 98765 43210", "Father"],
    ["Wei", "Chen", null, "1992-01-09", "male", "wei.chen@example.com", "0491 570 204", "AB+", null, null, null, null, "Lin Chen", "0491 570 214", "Sister"],
    ["Aroha", "Ngata", null, "1980-05-30", "female", "aroha.ngata@example.com", "0491 570 205", "O-", "4275398763", 2, "2027-11-30", null, "Rawiri Ngata", "0491 570 215", "Brother"],
    ["Lukas", "Becker", null, "1995-09-17", "male", "lukas.becker@example.com", "0491 570 206", "A+", null, null, null, null, "Anna Becker", "+49 151 23456789", "Mother"],
    ["Mia", "Brown", null, "2017-08-03", "female", "olivia.brown+mia@example.com", null, "O+", "2953176541", 2, "2029-06-30", null, "Olivia Brown", "0491 570 201", "Mother"],
    ["Ahmed", "Hassan", null, "1968-12-25", "male", "ahmed.hassan@example.com", "0491 570 208", "B-", "5386409874", 1, "2028-09-30", null, "Fatima Hassan", "0491 570 218", "Wife"],
  ];
  state.patients = pats.map(
    ([first_name, last_name, preferred_name, date_of_birth, sex, email, phone, blood_type, medicare_number, medicare_irn, medicare_expiry, ihi_number, ecn, ecp, ecr], i) => ({
      id: PAT(i + 1),
      auth_user_id: null,
      first_name,
      last_name,
      preferred_name,
      date_of_birth,
      sex,
      gender_identity: null,
      email,
      phone,
      blood_type,
      medicare_number,
      medicare_irn,
      medicare_expiry,
      ihi_number,
      emergency_contact_name: ecn,
      emergency_contact_phone: ecp,
      emergency_contact_relationship: ecr,
      is_active: true,
      ...stamp,
    }),
  );

  const addr: [number, PatientAddress["address_type"], string, string, string, string, IsoDate, IsoDate | null][] = [
    [1, "residential", "8 Latrobe Terrace", "Paddington", "QLD", "4064", "2018-01-01", d(-200)],
    [1, "residential", "27 Vulture Street", "West End", "QLD", "4101", d(-200), null],
    [7, "residential", "8 Latrobe Terrace", "Paddington", "QLD", "4064", "2018-01-01", d(-200)],
    [7, "residential", "27 Vulture Street", "West End", "QLD", "4101", d(-200), null],
    [2, "residential", "14 Kedron Brook Road", "Wilston", "QLD", "4051", "2015-06-01", null],
    [2, "postal", "PO Box 552", "Wilston", "QLD", "4051", "2015-06-01", null],
    [3, "residential", "Unit 12, 30 Hope Street", "South Brisbane", "QLD", "4101", "2021-02-01", null],
    [4, "residential", "5 Baroona Road", "Milton", "QLD", "4064", "2024-03-01", null],
    [5, "residential", "62 Ellena Street", "Paddington", "QLD", "4064", "2019-09-01", null],
    [6, "residential", "Room 4, 99 Melbourne Street", "South Brisbane", "QLD", "4101", d(-60), null],
    [8, "residential", "17 Marsden Street", "Parramatta", "NSW", "2150", "2012-01-01", null],
  ];
  for (const [p, address_type, address_line1, suburb, st, postcode, valid_from, valid_to] of addr) {
    state.patient_addresses.push({
      id: nextId(state, ID_PREFIX.address),
      patient_id: PAT(p),
      address_type,
      address_line1,
      address_line2: null,
      suburb,
      state: st,
      postcode,
      country: "Australia",
      valid_from,
      valid_to,
      ...stamp,
    });
  }

  const res: [number, number, string | null, IsoDate, IsoDate | null][] = [
    [1, 1, null, "1988-03-14", null],
    [2, 1, null, "1975-11-02", null],
    [3, 4, "VGN-500-118203", "2021-02-01", d(-120)],
    [3, 8, "VGN-485-220417", d(-120), null],
    [4, 5, "VGN-482-330561", "2024-03-01", null],
    [5, 3, null, "2019-09-01", null],
    [6, 6, "VGN-600-441298", d(-60), d(30)],
    [7, 1, null, "2017-08-03", null],
    [8, 2, "VGN-189-552634", "2012-01-01", null],
  ];
  for (const [p, r, visa_grant_number, valid_from, valid_to] of res) {
    state.patient_residency.push({
      id: nextId(state, ID_PREFIX.residency),
      patient_id: PAT(p),
      residency_status_id: RS(r),
      visa_grant_number,
      valid_from,
      valid_to,
      ...stamp,
    });
  }

  const pol: [number, number, number, string, boolean, IsoDate, IsoDate | null][] = [
    [1, 1, 2, "SHF-448210", true, "2019-01-01", d(-30)],
    [2, 1, 1, "SHF-448210", true, d(-30), null],
    [3, 7, 2, "SHF-448210", false, "2019-01-01", d(-30)],
    [4, 7, 1, "SHF-448210", false, d(-30), null],
    [5, 2, 3, "HH-7781203", true, "2016-07-01", null],
    [6, 3, 5, "CC-2021-0457", true, "2021-02-01", d(-120)],
    [7, 3, 6, "WVC-889014", true, d(-120), null],
    [8, 4, 6, "WVC-771392", true, "2024-03-01", null],
    [9, 6, 6, "WVC-990215", true, d(-60), d(30)],
    [10, 8, 1, "SHF-302991", true, "2012-02-01", null],
  ];
  state.patient_insurance_policies = pol.map(([id, p, plan, membership_number, is_primary_holder, valid_from, valid_to]) => ({
    id: POL(id),
    patient_id: PAT(p),
    plan_id: PLAN(plan),
    membership_number,
    is_primary_holder,
    valid_from,
    valid_to,
    ...stamp,
  }));

  // 7. Past appointments, with hand-written status history
  const history = (appointment_id: Uuid, from: AppointmentStatus | null, to: AppointmentStatus, at: string) =>
    state.appointment_status_history.push({
      id: nextSerial(state, "history"),
      appointment_id,
      from_status: from,
      to_status: to,
      changed_at: at,
      changed_by: null,
    });

  type Past = [number, number, number, number, number, number, string, number, AppointmentStatus, number | null, number | null, number | null, string, string, number | null, number | null, number | null, string | null, string | null, number, BookingChannel];
  const past: Past[] = [
    [1, 1, 1, 1, 2, -120, "09:00", 15, "completed", -5, 4, 12, "Annual health check", "standard", 85, 43.9, 41.1, "Routine check. BP 118/76. Ordered fasting bloods.", null, 6, "web"],
    [2, 2, 1, 1, 1, -10, "09:30", 15, "completed", -8, 2, 14, "Discuss blood test results", "standard", 85, 43.9, 41.1, "Mildly low iron. Started oral iron supplement, repeat bloods in 3 months.", null, 3, "mobile"],
    [3, 3, 2, 2, 1, -45, "13:00", 15, "completed", 3, 35, 10, "Lower back pain", "standard", 85, 43.9, 41.1, "Mechanical back pain. Advised physio and simple analgesia.", null, 1, "phone"],
    [4, 4, 2, 2, 1, -5, "13:30", 15, "no_show", null, null, null, "Follow-up back pain", "standard", null, null, null, null, null, 7, "web"],
    [5, 5, 3, 3, 2, -150, "10:00", 20, "completed", -2, 5, 15, "Sore throat and fever", "standard", 85, 0, 85, "Viral pharyngitis. Supportive care, medical certificate 2 days.", null, 0, "mobile"],
    [6, 6, 3, 3, 2, -20, "10:20", 20, "completed", 0, 6, 16, "Skin rash on arms", "standard", 85, 0, 85, "Contact dermatitis. Topical steroid prescribed.", null, 2, "web"],
    [7, 7, 4, 2, 2, -15, "09:15", 15, "cancelled", null, null, null, "Work medical certificate", "standard", null, null, null, null, "Feeling better, no longer needed", 4, "web"],
    [8, 8, 4, 4, 3, -8, "09:30", 30, "completed", -10, 15, 25, "Skin check - changing mole", "long", 250, 0, 250, "Full skin check. Mole on left shoulder benign on dermoscopy; review in 12 months.", null, 21, "phone"],
    [9, 9, 5, 6, 1, -30, "09:00", 30, "completed", 1, 3, 10, "Flu vaccination", "vaccination", 0, 0, 0, "Influenza vaccine administered, left deltoid. No immediate reaction.", null, 5, "web"],
    [10, 10, 7, 1, 1, -3, "10:00", 15, "completed", -4, 1, 11, "Ear pain (child)", "standard", 43.9, 43.9, 0, "Otitis media, left ear. Amoxicillin 5 days. Bulk billed (under 16).", null, 1, "mobile"],
    [11, 11, 8, 5, 4, -12, "09:00", 15, "completed", -6, 0, 13, "Repeat prescription - blood pressure", "standard", 43.9, 43.9, 0, "BP well controlled on current dose. 6-month script issued.", null, 10, "web"],
    [12, 12, 6, 3, 2, -2, "11:00", 20, "completed", 2, 4, 18, "Sprained ankle", "standard", 95, 0, 95, "Lateral ankle sprain, Ottawa rules negative. RICE, review if not improving in 1 week.", null, 0, "mobile"],
    [13, 13, 1, 6, 1, -60, "09:30", 30, "completed", -1, 2, 20, "Cervical screening test", "standard", 85, 43.9, 41.1, "Cervical screening collected. Results to be sent by SMS.", null, 14, "web"],
    [15, 15, 5, 2, 1, -24, "15:00", 15, "completed", -3, 5, 9, "Medication review", "standard", 85, 43.9, 41.1, "Reviewed asthma preventer technique. No changes.", null, 6, "web"],
    [14, 14, 5, 2, 1, -25, "14:00", 15, "rescheduled", null, null, null, "Medication review", "standard", null, null, null, null, null, 8, "web"],
  ];
  for (const [id, slot, p, c, f, dayOff, startTime, mins, status, late, wait, consult, reason, visitType, fee, rebate, gap, notes, cancelReason, bookedBefore, channel] of past) {
    const tz = facilityTz(state, FAC(f));
    let day = d(dayOff);
    day = addDays(day, -Math.max(isoDow(day) - 5, 0)); // keep past visits on weekdays
    const start = zonedToUtc(day, startTime, tz);
    const end = plusMin(start, mins);
    const booked = new Date(start.getTime() - bookedBefore * 86_400_000 - 3 * 3_600_000);
    const reminder = new Date(start.getTime() - 86_400_000);
    const checkin = late !== null ? plusMin(start, late) : null;
    const cstart = wait !== null ? plusMin(start, wait) : null;
    const cend = consult !== null && cstart ? plusMin(cstart, consult) : null;

    state.appointment_slots.push({
      id: SLOT(slot),
      clinician_id: CLIN(c),
      facility_id: FAC(f),
      starts_at: ts(start),
      ends_at: ts(end),
      status: status === "cancelled" || status === "rescheduled" ? "available" : "booked",
      held_by_patient_id: null,
      held_until: null,
      source_schedule_id: null,
      source_exception_id: null,
      created_at: ts(new Date(start.getTime() - 60 * 86_400_000)),
      updated_at: nowIso,
    });

    const affiliation = affiliationOn(state, CLIN(c), FAC(f), day);
    state.appointments.push({
      id: APPT(id),
      slot_id: SLOT(slot),
      patient_id: PAT(p),
      clinician_id: CLIN(c),
      facility_id: FAC(f),
      clinician_affiliation_id: affiliation!.id,
      patient_insurance_policy_id: policyOn(state, PAT(p), day)?.id ?? null,
      scheduled_start: ts(start),
      scheduled_end: ts(end),
      status,
      visit_type: visitType,
      reason,
      booking_channel: channel,
      booked_at: ts(booked),
      booked_by: null,
      confirmed_at: status === "completed" || status === "no_show" ? ts(plusMin(reminder, 120)) : null,
      reminder_sent_at: status === "completed" || status === "no_show" ? ts(reminder) : null,
      checked_in_at: checkin && ts(checkin),
      consult_started_at: cstart && ts(cstart),
      consult_ended_at: cend && ts(cend),
      no_show_marked_at: status === "no_show" ? ts(plusMin(start, 30)) : null,
      cancelled_at: status === "cancelled" ? ts(new Date(start.getTime() - 2 * 86_400_000)) : null,
      cancelled_by: null,
      cancellation_reason: cancelReason,
      rescheduled_to_appointment_id: null,
      clinical_notes: notes,
      fee_charged: fee,
      medicare_rebate: rebate,
      gap_amount: gap,
      created_at: ts(booked),
      updated_at: nowIso,
    });

    history(APPT(id), null, "booked", ts(booked));
    if (status === "completed" || status === "no_show") {
      history(APPT(id), "booked", "confirmed", ts(plusMin(reminder, 120)));
    }
    if (status === "completed") {
      history(APPT(id), "confirmed", "checked_in", ts(checkin!));
      history(APPT(id), "checked_in", "in_consultation", ts(cstart!));
      history(APPT(id), "in_consultation", "completed", ts(cend!));
    } else if (status === "no_show") {
      history(APPT(id), "confirmed", "no_show", ts(plusMin(start, 30)));
    } else if (status === "cancelled") {
      history(APPT(id), "booked", "cancelled", ts(new Date(start.getTime() - 2 * 86_400_000)));
    } else if (status === "rescheduled") {
      history(APPT(id), "booked", "rescheduled", ts(new Date(start.getTime() - 86_400_000)));
    }
  }
  state.appointments.find((a) => a.id === APPT(14))!.rescheduled_to_appointment_id = APPT(15);

  // 8. Future slots, leave and an extra Saturday session
  generateSlots(state, today, d(56), now);

  state.schedule_exceptions.push({
    id: nextId(state, ID_PREFIX.exception),
    clinician_id: CLIN(3),
    facility_id: null,
    exception_type: "unavailable",
    starts_at: ts(zonedToUtc(d(7), "00:00", "Australia/Brisbane")),
    ends_at: ts(zonedToUtc(d(12), "00:00", "Australia/Brisbane")),
    slot_minutes: null,
    reason: "Annual leave",
    ...stamp,
  });
  syncSlotBlocks(state, CLIN(3), now);

  const dow = isoDow(today);
  const sat = addDays(today, 6 - dow <= 0 ? 13 - dow : 6 - dow);
  const extra: ScheduleException = {
    id: nextId(state, ID_PREFIX.exception),
    clinician_id: CLIN(1),
    facility_id: FAC(1),
    exception_type: "extra_session",
    starts_at: ts(zonedToUtc(sat, "09:00", "Australia/Brisbane")),
    ends_at: ts(zonedToUtc(sat, "11:00", "Australia/Brisbane")),
    slot_minutes: 15,
    reason: "Saturday flu clinic",
    ...stamp,
  };
  state.schedule_exceptions.push(extra);
  generateSlots(state, extra.starts_at.slice(0, 10), extra.ends_at.slice(0, 10), now);
  syncSlotBlocks(state, CLIN(1), now);

  // 9. Upcoming appointments, booked like public._book_slot
  const future: [number, number, number, number, string, BookingChannel][] = [
    [1, 1, 1, 2, "Repeat blood test review", "mobile"],
    [2, 2, 1, 3, "Back pain follow-up (rebooked after missed visit)", "phone"],
    [3, 3, 2, 1, "Rash review", "web"],
    [4, 4, 3, 14, "Mole removal consult", "phone"],
    [5, 6, 1, 4, "COVID-19 booster", "web"],
    [6, 3, 2, 5, "Ankle review", "mobile"],
    [8, 5, 4, 2, "Blood pressure check", "web"],
    [7, 2, 1, 6, "Ear check after antibiotics", "mobile"],
  ];
  let upcomingNo = 100;
  for (const [p, c, f, daysAhead, reason, channel] of future) {
    const after = ts(zonedToUtc(d(daysAhead), "00:00", "Australia/Brisbane"));
    const slot = state.appointment_slots
      .filter((s) => s.clinician_id === CLIN(c) && s.facility_id === FAC(f) && s.status === "available" && s.starts_at >= after)
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
    if (!slot) continue;
    slot.status = "booked";
    const day = localDate(slot.starts_at, facilityTz(state, slot.facility_id));
    const id = APPT(++upcomingNo);
    state.appointments.push({
      id,
      slot_id: slot.id,
      patient_id: PAT(p),
      clinician_id: CLIN(c),
      facility_id: FAC(f),
      clinician_affiliation_id: affiliationOn(state, CLIN(c), FAC(f), day)!.id,
      patient_insurance_policy_id: policyOn(state, PAT(p), day)?.id ?? null,
      scheduled_start: slot.starts_at,
      scheduled_end: slot.ends_at,
      status: "booked",
      visit_type: "standard",
      reason,
      booking_channel: channel,
      booked_at: nowIso,
      booked_by: null,
      confirmed_at: null,
      reminder_sent_at: null,
      checked_in_at: null,
      consult_started_at: null,
      consult_ended_at: null,
      no_show_marked_at: null,
      cancelled_at: null,
      cancelled_by: null,
      cancellation_reason: null,
      rescheduled_to_appointment_id: null,
      clinical_notes: null,
      fee_charged: null,
      medicare_rebate: null,
      gap_amount: null,
      created_at: nowIso,
      updated_at: nowIso,
    });
    history(id, null, "booked", nowIso);
  }

  const in4days = ts(new Date(now.getTime() + 4 * 86_400_000));
  for (const a of state.appointments) {
    if (a.status === "booked" && a.scheduled_start < in4days && a.scheduled_start > nowIso) {
      a.status = "confirmed";
      a.confirmed_at = nowIso;
      a.reminder_sent_at = ts(new Date(now.getTime() - 3_600_000));
      history(a.id, "booked", "confirmed", nowIso);
    }
  }

  const lukasNext = state.appointments
    .filter((a) => a.patient_id === PAT(6) && a.scheduled_start > nowIso)
    .sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start))[0];
  if (lukasNext) {
    const from = lukasNext.status;
    Object.assign(lukasNext, {
      status: "cancelled",
      cancellation_reason: "Booked another time with my usual GP",
      cancelled_at: nowIso,
    });
    history(lukasNext.id, from, "cancelled", nowIso);
    const slot = state.appointment_slots.find((s) => s.id === lukasNext.slot_id);
    if (slot && slot.status === "booked" && slot.starts_at > nowIso) slot.status = "available";
    syncSlotBlocks(state, lukasNext.clinician_id, now);
  }

  // 10. Recording consents, sessions and transcripts
  const appt = (n: number) => state.appointments.find((a) => a.id === APPT(n))!;
  const consent = (row: Omit<RecordingConsent, "id" | "created_at" | "updated_at">) =>
    state.recording_consents.push({ id: nextId(state, ID_PREFIX.consent), ...row, ...stamp });
  for (const n of [2, 6, 10, 12, 13]) {
    const a = appt(n);
    const started = new Date(a.consult_started_at!);
    consent({
      appointment_id: a.id,
      party: "patient",
      patient_id: a.patient_id,
      clinician_id: null,
      consent_given: true,
      consent_text_version: "v1",
      method: "in_app",
      given_at: ts(plusMin(started, -2)),
      withdrawn_at: n === 6 ? ts(plusMin(started, 9)) : null,
      withdrawal_reason: n === 6 ? "Did not want my rash discussion recorded" : null,
    });
  }
  for (const n of [2, 6, 10, 12, 13]) {
    const a = appt(n);
    consent({
      appointment_id: a.id,
      party: "clinician",
      patient_id: null,
      clinician_id: a.clinician_id,
      consent_given: true,
      consent_text_version: "v1",
      method: "in_app",
      given_at: ts(plusMin(new Date(a.consult_started_at!), -1)),
      withdrawn_at: null,
      withdrawal_reason: null,
    });
  }
  const oliviaNext = state.appointments
    .filter((a) => a.patient_id === PAT(1) && a.scheduled_start > nowIso && (a.status === "booked" || a.status === "confirmed"))
    .sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start))[0];
  if (oliviaNext) {
    consent({
      appointment_id: oliviaNext.id,
      party: "patient",
      patient_id: oliviaNext.patient_id,
      clinician_id: null,
      consent_given: true,
      consent_text_version: "v1",
      method: "in_app",
      given_at: ts(new Date(now.getTime() - 86_400_000)),
      withdrawn_at: null,
      withdrawal_reason: null,
    });
  }

  const sessions: [number, number, RecordingStatus, number | null, string | null][] = [
    [1, 2, "approved", 780, null],
    [2, 10, "rejected", 600, null],
    [3, 12, "failed", null, "Speech-to-text failed: 503 Service Unavailable"],
    [4, 12, "awaiting_review", 960, null],
    [5, 13, "expired", 1140, null],
    [6, 6, "consent_withdrawn", null, null],
  ];
  for (const [id, n, status, secs, err] of sessions) {
    const a = appt(n);
    state.recording_sessions.push({
      id: SESS(id),
      appointment_id: a.id,
      started_by: a.patient_id, // as in the seed: the sample patients had no login yet
      started_at: ts(plusMin(new Date(a.consult_started_at!), 1)),
      ended_at: status !== "consent_withdrawn" ? a.consult_ended_at : null,
      duration_seconds: secs,
      engine: "sample-stt",
      engine_model: "stt-medical-v2",
      status,
      audio_discarded_at: ts(plusMin(new Date(a.consult_ended_at ?? a.consult_started_at!), 1)),
      error_message: err,
      ...stamp,
    });
  }

  const a2 = appt(2);
  const a2end = new Date(a2.consult_ended_at!);
  const segments: TranscriptSegment[] = [
    { speaker: "clinician", start_sec: 0, end_sec: 11, text: "Hi Olivia, I have your blood test results here. Most things look normal, but your iron levels are a bit low." },
    { speaker: "patient", start_sec: 11, end_sec: 15, text: "That would explain why I have been so tired lately." },
    { speaker: "clinician", start_sec: 15, end_sec: 29, text: "It could. I would like you to start an iron supplement once a day, ideally with some vitamin C, and we will repeat the blood test in three months." },
    { speaker: "patient", start_sec: 29, end_sec: 31, text: "Are there any side effects?" },
    { speaker: "clinician", start_sec: 31, end_sec: 40, text: "Some people get an upset stomach or constipation. If that happens, take it with food and let me know." },
  ];
  state.consult_transcripts.push({
    id: TRANS(1),
    recording_session_id: SESS(1),
    appointment_id: a2.id,
    transcript_text:
      "Dr Rao: Hi Olivia, I have your blood test results here. Most things look normal, but your iron levels are a bit low. " +
      "Olivia: That would explain why I have been so tired lately. " +
      "Dr Rao: It could. I would like you to start an iron supplement once a day, ideally with some vitamin C, and we will repeat the blood test in three months. " +
      "Olivia: Are there any side effects? " +
      "Dr Rao: Some people get an upset stomach or constipation. If that happens, take it with food and let me know.",
    segments,
    summary_text:
      "Iron levels slightly low. Start daily iron supplement with vitamin C. Repeat blood test in 3 months. Report stomach upset or constipation.",
    language: "en-AU",
    status: "approved",
    review_expires_at: ts(new Date(a2end.getTime() + 7 * 86_400_000)),
    approved_at: ts(plusMin(a2end, 180)),
    created_at: ts(plusMin(a2end, 2)),
    updated_at: nowIso,
  });
  const a12 = appt(12);
  state.consult_transcripts.push({
    id: TRANS(2),
    recording_session_id: SESS(4),
    appointment_id: a12.id,
    transcript_text:
      "Dr Williams: So you rolled your ankle playing football on Saturday? " +
      "Lukas: Yes, it swelled up straight away but I can walk on it. " +
      "Dr Williams: Good sign. There is no tenderness over the bones, so I do not think you need an X-ray. Rest, ice, compression and elevation for the next few days, and come back if it is not improving within a week.",
    segments: null,
    summary_text: "Lateral ankle sprain, no X-ray needed. RICE for several days. Return if not improving in 1 week.",
    language: "en-AU",
    status: "pending_patient_review",
    review_expires_at: ts(new Date(now.getTime() + 5 * 86_400_000)),
    approved_at: null,
    created_at: ts(plusMin(new Date(a12.consult_ended_at!), 2)),
    updated_at: nowIso,
  });

  // 11. Ratings
  const ratings: [number, number, number, number, boolean, string, boolean, ModerationStatus, number][] = [
    [2, 5, 5, 5, true, "Dr Rao listened carefully and explained my blood test results in plain language.", false, "visible", 5],
    [3, 3, 4, 2, true, "Good advice for my back, but I waited 35 minutes past my appointment time.", false, "visible", 20],
    [6, 4, 4, 5, true, "Thorough and friendly, though the consult felt a little rushed at the end.", true, "visible", 30],
    [8, 1, 1, 3, false, "Rude doctor, complete waste of money, avoid at all costs!!!", false, "hidden", 2],
    [11, 5, 5, 5, true, "On time, very professional, and sorted my prescription in a few minutes.", false, "visible", 8],
    [15, 4, 5, 4, true, "Quick appointment and clear instructions on using my asthma inhaler properly.", false, "visible", 26],
  ];
  for (const [n, rating, comm, wait, rec, comment, anon, moderation, hours] of ratings) {
    const a = appt(n);
    const at = ts(new Date(new Date(a.consult_ended_at!).getTime() + hours * 3_600_000));
    state.clinician_ratings.push({
      id: nextId(state, ID_PREFIX.rating),
      appointment_id: a.id,
      patient_id: a.patient_id,
      clinician_id: a.clinician_id,
      rating,
      rating_communication: comm,
      rating_wait_time: wait,
      would_recommend: rec,
      comment,
      is_anonymous: anon,
      moderation_status: moderation,
      created_at: at,
      updated_at: at,
    });
  }

  // 12. Insurance claims
  const claims: [number, string, number, number | null, number | null, InsuranceClaim["status"], string | null][] = [
    [5, "CC-CLM-10021", 85, 85, 85, "paid", null],
    [6, "WVC-CLM-55813", 85, null, null, "submitted", null],
    [8, "WVC-CLM-55790", 250, 0, 0, "rejected", "Pre-existing condition waiting period applies"],
    [12, "WVC-CLM-56002", 95, null, null, "draft", null],
  ];
  for (const [n, claim_number, claimed, approved, paid, status, reason] of claims) {
    const a = appt(n);
    const end = new Date(a.consult_ended_at!);
    state.insurance_claims.push({
      id: nextId(state, ID_PREFIX.claim),
      appointment_id: a.id,
      patient_insurance_policy_id: a.patient_insurance_policy_id!,
      claim_number,
      amount_claimed: claimed,
      amount_approved: approved,
      amount_paid: paid,
      status,
      submitted_at: status === "draft" ? null : ts(plusMin(end, 60)),
      processed_at: ["paid", "rejected", "approved"].includes(status) ? ts(new Date(end.getTime() + 9 * 86_400_000)) : null,
      rejection_reason: reason,
      ...stamp,
    });
  }

  // 03_sample_vitals.sql
  const vitals: [number, number | null, number | null, number | null, number | null, number | null, number | null, string | null, number][] = [
    [1, 36.6, 99, 118, 76, 167.0, 64.2, null, 3],
    [13, 36.5, 98, 120, 78, 167.0, 63.5, null, 2],
    [2, 36.7, 98, 116, 74, 167.0, 62.8, "Reports tiredness", 4],
    [3, 36.8, 97, 142, 91, 181.0, 94.6, "BP elevated, patient in pain", 5],
    [5, 38.4, 97, 112, 70, 158.5, 52.1, "Febrile", 2],
    [6, 36.6, 99, 110, 68, 158.5, 52.8, null, 3],
    [8, 36.5, 98, 124, 80, 174.0, 71.3, null, 6],
    [9, 36.4, 98, 126, 82, null, null, "Pre-vaccination check", 1],
    [10, 38.1, 98, null, null, 121.5, 23.4, "Child, BP not taken", 2],
    [11, 36.6, 96, 148, 92, 172.0, 88.9, "First reading", 2],
    [12, 36.7, 99, 122, 76, 186.0, 82.0, null, 3],
    [15, 36.5, 95, 118, 77, 164.0, 70.4, "Asthmatic, SpO2 at usual baseline", 4],
  ];
  const addVitals = (n: number, v: Partial<VisitVitals>, mins: number) => {
    const a = appt(n);
    const recorded = ts(plusMin(new Date(a.checked_in_at!), mins));
    state.visit_vitals.push({
      id: nextId(state, ID_PREFIX.vitals),
      appointment_id: a.id,
      patient_id: a.patient_id,
      temperature_c: null,
      spo2_percent: null,
      bp_systolic: null,
      bp_diastolic: null,
      height_cm: null,
      weight_kg: null,
      notes: null,
      ...v,
      bmi: computeBmi(v.height_cm ?? null, v.weight_kg ?? null),
      recorded_at: recorded,
      recorded_by: null,
      created_at: recorded,
      updated_at: recorded,
    });
  };
  for (const [n, temperature_c, spo2_percent, bp_systolic, bp_diastolic, height_cm, weight_kg, notes, mins] of vitals) {
    addVitals(n, { temperature_c, spo2_percent, bp_systolic, bp_diastolic, height_cm, weight_kg, notes }, mins);
  }
  addVitals(11, { bp_systolic: 134, bp_diastolic: 84, notes: "Repeat BP after 5 minutes seated rest" }, 9);

  // 02_link_test_logins.sql: link by email; staff role is already on the user.
  for (const u of state.users) {
    const p = state.patients.find((x) => x.email?.toLowerCase() === u.email.toLowerCase());
    if (p) p.auth_user_id = u.id;
    const c = state.clinicians.find((x) => x.email?.toLowerCase() === u.email.toLowerCase());
    if (c) c.auth_user_id = u.id;
  }

  // 13. Agent layer (04_agent_layer_sample.sql builds segments for Olivia's
  // approved transcript; the documentation agent then drafts key points and
  // facts for Dr Rao to review). Plus one open GP question from Olivia.
  const olivia2 = state.consult_transcripts.find((t) => t.id === TRANS(1))!;
  runMockConsultWorker(state.agent, olivia2, a2.patient_id, ts(plusMin(new Date(olivia2.approved_at!), 5)));
  state.agent.gp_queries.push({
    id: "73000000-0000-4000-8000-000000000001",
    appointment_id: a2.id,
    question: "Can I take the iron supplement at the same time as my morning coffee?",
    context_fact_ids: [],
    status: "open",
    answer: null,
    answered_by: null,
    answered_at: null,
    created_by_agent: "insights-writer",
    created_at: ts(new Date(now.getTime() - 26 * 3_600_000)),
    updated_at: nowIso,
  });
  const plan = state.insurance_plans[0];
  seedResearchDrafts(state.agent, ts(new Date(now.getTime() - 5 * 3_600_000)), {
    plan: plan.id,
    facility: state.facilities[0].id,
    provider: plan.provider_id,
  });
  const hoursAgo = (h: number) => ts(new Date(now.getTime() - h * 3_600_000));
  const sample: [string, string, string, boolean, number, number][] = [
    ["patient-concierge", "matching", "find_gp_candidates", true, 310, 3],
    ["patient-concierge", "matching", "get_fees", true, 95, 3],
    ["patient-concierge", "booking", "propose_booking", true, 140, 2],
    ["insights", "patient_record", "get_approved_facts", true, 80, 6],
    ["insurance", "matching", "get_plan_coverage", true, 120, 4],
    ["insurance", "web_research", "web_search", false, 2100, 4],
    ["research-job", "web_research", "web_extract", true, 1650, 9],
  ];
  for (const [agent_id, server, tool, ok, latency_ms, h] of sample) {
    state.agent.agent_access_log.push({ agent_id, server, tool, ok, latency_ms, created_at: hoursAgo(h) });
  }

  return state;
}

/** bmi generated column: round(weight / (height/100)^2, 1) when both are present. */
export function computeBmi(heightCm: number | null, weightKg: number | null): number | null {
  if (heightCm === null || weightKg === null) return null;
  return Math.round((weightKg / ((heightCm / 100) * (heightCm / 100))) * 10) / 10;
}
