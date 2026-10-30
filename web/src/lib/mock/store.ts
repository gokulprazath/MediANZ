// The mock data layer: DataApi over the in-memory seed. Each method follows
// the SQL it stands for: the RLS policy (who can see or change which rows),
// the RPC body, the triggers and the check / exclusion constraints, and it
// raises the same error messages, so the app behaves the same in both modes.
import {
  DataError,
  type AppointmentFilter,
  type DataApi,
  type Me,
  type RatingWithRefs,
  type TranscribeChunkResult,
  type TranscribeFinishResult,
} from "@/lib/data/api";
import { localDate, todayUtc } from "@/lib/time";
import {
  CLINICIAN_SUMMARY_COLUMNS,
  FACILITY_SUMMARY_COLUMNS,
  PATIENT_SUMMARY_COLUMNS,
  type Appointment,
  type AppointmentSlot,
  type AppointmentStatus,
  type AppointmentWithRefs,
  type BookingChannel,
  type ClinicianRating,
  type ConsultTranscript,
  type IsoDate,
  type Patient,
  type RatingInput,
  type TranscriptSegment,
  type Uuid,
  type VisitVitals,
  type VisitVitalsLatest,
} from "@/types/db";
import {
  affiliationOn,
  computeBmi,
  facilityTz,
  generateSlots,
  ID_PREFIX,
  nextId,
  nextSerial,
  policyOn,
  syncSlotBlocks,
  validOn,
  type MockState,
} from "./seed";

export interface MockCtx {
  uid: Uuid;
  email: string | null;
  appRole: "staff" | "admin" | null;
  signupRole: string | null;
  patientId: Uuid | null; // public.current_patient_id()
  clinicianId: Uuid | null; // public.current_clinician_id()
}

export function ctxFor(state: MockState, uid: Uuid): MockCtx {
  const user = state.users.find((u) => u.id === uid);
  return {
    uid,
    email: user?.email ?? null,
    appRole: user?.app_metadata.role ?? null,
    signupRole: user?.user_metadata.signup_role ?? null,
    patientId: state.patients.find((p) => p.auth_user_id === uid)?.id ?? null,
    clinicianId: state.clinicians.find((c) => c.auth_user_id === uid)?.id ?? null,
  };
}

const fail = (message: string, code: string | null = "P0001"): never => {
  throw new DataError(message, code);
};
const rls = (table: string): never =>
  fail(`new row violates row-level security policy for table "${table}"`, "42501");
const notFound = (): never => fail("Cannot coerce the result to a single JSON object", "PGRST116");
const checkViolation = (table: string, constraint: string): never =>
  fail(`new row for relation "${table}" violates check constraint "${constraint}"`, "23514");
const exclusionViolation = (table: string): never =>
  fail(`conflicting key value violates exclusion constraint "${table}_excl"`, "23P01");

const clone = <T>(v: T): T => structuredClone(v);
const pick = <T extends object>(row: T, columns: string): Partial<T> => {
  const out: Partial<T> = {};
  for (const c of columns.split(",")) (out as Record<string, unknown>)[c] = (row as Record<string, unknown>)[c];
  return out;
};

function rangesOverlap(aFrom: IsoDate, aTo: IsoDate | null, bFrom: IsoDate, bTo: IsoDate | null): boolean {
  return (bTo === null || aFrom < bTo) && (aTo === null || bFrom < aTo);
}

const RE = {
  medicare: /^\d{10}$/,
  ihi: /^\d{16}$/,
  ahpra: /^[A-Z]{3}\d{10}$/,
  provider: /^\d{6}[0-9A-Z]{2}$/,
};

const CONSENT_VERSIONS = new Set(["v1", "v2"]); // consent_text_versions (agent layer seeds both)

// appointments_before_update: allowed status changes
const NEXT_STATUS: Record<AppointmentStatus, AppointmentStatus[]> = {
  booked: ["confirmed", "checked_in", "cancelled", "no_show", "rescheduled"],
  confirmed: ["checked_in", "cancelled", "no_show", "rescheduled"],
  checked_in: ["in_consultation", "cancelled"],
  in_consultation: ["completed"],
  completed: [],
  cancelled: [],
  no_show: [],
  rescheduled: [],
};

export interface MockApiOptions {
  now?: () => Date;
}

export function createMockApi(state: MockState, uid: Uuid | null, options: MockApiOptions = {}): DataApi {
  const now = options.now ?? (() => new Date());
  const nowIso = () => now().toISOString();
  const today = () => todayUtc(now());

  const ctx = (): MockCtx => {
    if (!uid) fail("JWT expired or missing", "PGRST301");
    return ctxFor(state, uid!);
  };
  const isStaff = () => {
    const c = ctx();
    return c.appRole === "staff" || c.appRole === "admin";
  };
  const requireStaff = (table: string) => {
    if (!isStaff()) rls(table);
  };

  // ---------------------------------------------------------------------------
  // RLS visibility
  // ---------------------------------------------------------------------------
  const canSeeAppointment = (a: Appointment) => {
    const c = ctx();
    return a.patient_id === c.patientId || a.clinician_id === c.clinicianId || isStaff();
  };
  const canSeePatient = (p: Patient) => {
    const c = ctx();
    return (
      p.auth_user_id === c.uid ||
      isStaff() ||
      (c.clinicianId !== null &&
        state.appointments.some((a) => a.patient_id === p.id && a.clinician_id === c.clinicianId))
    );
  };
  const ownsPatientRow = (patientId: Uuid) => patientId === ctx().patientId || isStaff();

  const withRefs = (a: Appointment): AppointmentWithRefs => {
    const p = state.patients.find((x) => x.id === a.patient_id)!;
    const c = state.clinicians.find((x) => x.id === a.clinician_id)!;
    const f = state.facilities.find((x) => x.id === a.facility_id)!;
    return {
      ...clone(a),
      patient: canSeePatient(p) ? (pick(p, PATIENT_SUMMARY_COLUMNS) as AppointmentWithRefs["patient"]) : null,
      clinician: pick(c, CLINICIAN_SUMMARY_COLUMNS) as AppointmentWithRefs["clinician"],
      facility: pick(f, FACILITY_SUMMARY_COLUMNS) as AppointmentWithRefs["facility"],
    };
  };

  const appointmentById = (id: Uuid) => state.appointments.find((a) => a.id === id) ?? null;

  // ---------------------------------------------------------------------------
  // Triggers on appointments
  // ---------------------------------------------------------------------------
  const history = (appointmentId: Uuid, from: AppointmentStatus | null, to: AppointmentStatus) =>
    state.appointment_status_history.push({
      id: nextSerial(state, "history"),
      appointment_id: appointmentId,
      from_status: from,
      to_status: to,
      changed_at: nowIso(),
      changed_by: uid,
    });

  const setStatus = (a: Appointment, to: AppointmentStatus, extra: Partial<Appointment> = {}) => {
    if (a.status === to) {
      Object.assign(a, extra, { updated_at: nowIso() });
      return;
    }
    if (!NEXT_STATUS[a.status].includes(to)) {
      fail(`Invalid appointment status change: ${a.status} -> ${to}`, "23514");
    }
    const from = a.status;
    const at = nowIso();
    Object.assign(a, extra, { status: to, updated_at: at });
    switch (to) {
      case "confirmed":
        a.confirmed_at ??= at;
        break;
      case "checked_in":
        a.checked_in_at ??= at;
        a.patient_insurance_policy_id =
          policyOn(state, a.patient_id, localDate(a.scheduled_start, facilityTz(state, a.facility_id)))?.id ?? null;
        break;
      case "in_consultation":
        a.consult_started_at ??= at;
        break;
      case "completed":
        a.consult_ended_at ??= at;
        break;
      case "cancelled":
        a.cancelled_at ??= at;
        a.cancelled_by ??= uid;
        break;
      case "no_show":
        a.no_show_marked_at ??= at;
        break;
    }
    history(a.id, from, to);
    if (to === "cancelled" || to === "rescheduled") {
      const slot = state.appointment_slots.find((s) => s.id === a.slot_id);
      if (slot && slot.status === "booked" && slot.starts_at > at) {
        slot.status = "available";
        slot.updated_at = at;
      }
      syncSlotBlocks(state, a.clinician_id, now());
    }
  };

  // public._book_slot
  const bookSlotFor = (
    slotId: Uuid,
    patientId: Uuid,
    channel: BookingChannel,
    reason: string | null,
    visitType: string | null,
  ): Uuid => {
    const at = nowIso();
    const slot = state.appointment_slots.find(
      (s) =>
        s.id === slotId &&
        s.starts_at > at &&
        (s.status === "available" ||
          (s.status === "held" && ((s.held_until ?? "") < at || s.held_by_patient_id === patientId))),
    );
    if (!slot) fail("Slot is no longer available");
    const day = localDate(slot!.starts_at, facilityTz(state, slot!.facility_id));
    const affiliation = affiliationOn(state, slot!.clinician_id, slot!.facility_id, day);
    if (!affiliation) fail(`Clinician is not affiliated with this facility on ${day}`);
    Object.assign(slot!, { status: "booked", held_by_patient_id: null, held_until: null, updated_at: at });
    const id = crypto.randomUUID();
    state.appointments.push({
      id,
      slot_id: slot!.id,
      patient_id: patientId,
      clinician_id: slot!.clinician_id,
      facility_id: slot!.facility_id,
      clinician_affiliation_id: affiliation!.id,
      patient_insurance_policy_id: policyOn(state, patientId, day)?.id ?? null,
      scheduled_start: slot!.starts_at,
      scheduled_end: slot!.ends_at,
      status: "booked",
      visit_type: visitType,
      reason,
      booking_channel: channel,
      booked_at: at,
      booked_by: uid,
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
      created_at: at,
      updated_at: at,
    });
    history(id, null, "booked");
    return id;
  };

  // ---------------------------------------------------------------------------
  // Recording helpers
  // ---------------------------------------------------------------------------
  const recordingAllowed = (appointmentId: Uuid) =>
    state.recording_consents.filter((c) => c.appointment_id === appointmentId && c.consent_given && !c.withdrawn_at)
      .length === 2;

  const setSessionStatus = (sessionId: Uuid, patch: Partial<(typeof state.recording_sessions)[number]>) => {
    const s = state.recording_sessions.find((x) => x.id === sessionId);
    if (!s) return;
    const changed = patch.status !== undefined && patch.status !== s.status;
    Object.assign(s, patch, { updated_at: nowIso() });
    // recording_sessions_clear_chunks
    if (changed && s.status !== "started") {
      state.recording_session_chunks = state.recording_session_chunks.filter((c) => c.session_id !== s.id);
    }
  };

  // public.check_recording_chunk_allowed (user token)
  const checkChunkAllowed = (sessionId: Uuid, forFinish: boolean) => {
    const s = state.recording_sessions.find((x) => x.id === sessionId);
    if (!s) fail("Recording session not found", "42501");
    const a = appointmentById(s!.appointment_id)!;
    const c = ctx();
    if (!(a.patient_id === c.patientId || a.clinician_id === c.clinicianId)) {
      fail("Not a participant of this appointment", "42501");
    }
    if (s!.status !== "started") fail(`Recording session is no longer open (status: ${s!.status})`);
    if (!(a.status === "checked_in" || a.status === "in_consultation" || (forFinish && a.status === "completed"))) {
      fail("Recording is only allowed during the consultation");
    }
    if (!recordingAllowed(a.id)) fail("Recording consent is missing or was withdrawn", "42501");
    return s!;
  };

  // ---------------------------------------------------------------------------
  // History-aware rows (end the current row today, add a new one from today)
  // ---------------------------------------------------------------------------
  type Ranged = { id: Uuid; valid_from: IsoDate; valid_to: IsoDate | null; updated_at: string };
  function replaceCurrent<T extends Ranged>(
    table: string,
    rows: T[],
    current: T | undefined,
    build: (validFrom: IsoDate) => T | null,
    overlapsWith: (row: T) => boolean,
  ): T | null {
    const t = today();
    if (current && current.valid_from >= t) {
      // Started today: there is no earlier day to keep it for, so it is corrected in place.
      const next = build(current.valid_from);
      if (!next) {
        // Ending a row that started today would break valid_to > valid_from.
        checkViolation(table, `${table}_check`);
      }
      Object.assign(current, { ...next, id: current.id, created_at: (current as { created_at?: string }).created_at });
      return current;
    }
    const next = build(t);
    if (next && rows.some((r) => r !== current && overlapsWith(r) && rangesOverlap(r.valid_from, r.valid_to, t, null))) {
      exclusionViolation(table);
    }
    if (current) Object.assign(current, { valid_to: t, updated_at: nowIso() });
    if (next) rows.push(next);
    return next;
  }

  const currentOn = <T extends Ranged>(rows: T[], match: (r: T) => boolean) =>
    rows.find((r) => match(r) && validOn(r, today()));

  // ---------------------------------------------------------------------------
  // Patients: check constraints
  // ---------------------------------------------------------------------------
  const checkPatient = (p: Patient) => {
    if (!p.first_name?.trim() || !p.last_name?.trim()) fail('null value in column "first_name" violates not-null constraint', "23502");
    if (p.date_of_birth > today()) checkViolation("patients", "patients_date_of_birth_check");
    if (p.sex && !["female", "male", "intersex", "not_stated"].includes(p.sex)) checkViolation("patients", "patients_sex_check");
    if (p.blood_type && !["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "unknown"].includes(p.blood_type))
      checkViolation("patients", "patients_blood_type_check");
    if (p.medicare_number && !RE.medicare.test(p.medicare_number)) checkViolation("patients", "patients_medicare_number_check");
    if (p.medicare_irn !== null && (p.medicare_irn < 1 || p.medicare_irn > 9)) checkViolation("patients", "patients_medicare_irn_check");
    if (p.ihi_number && !RE.ihi.test(p.ihi_number)) checkViolation("patients", "patients_ihi_number_check");
  };

  const checkVitals = (v: VisitVitals) => {
    const range = (val: number | null, lo: number, hi: number, col: string) => {
      if (val !== null && (val < lo || val > hi)) checkViolation("visit_vitals", `visit_vitals_${col}_check`);
    };
    range(v.temperature_c, 30, 45, "temperature_c");
    range(v.spo2_percent, 50, 100, "spo2_percent");
    range(v.bp_systolic, 50, 300, "bp_systolic");
    range(v.bp_diastolic, 20, 200, "bp_diastolic");
    range(v.height_cm, 30, 250, "height_cm");
    range(v.weight_kg, 0.5, 400, "weight_kg");
    if ((v.bp_systolic === null) !== (v.bp_diastolic === null)) checkViolation("visit_vitals", "visit_vitals_check");
    if (v.bp_systolic !== null && v.bp_diastolic !== null && v.bp_systolic <= v.bp_diastolic)
      checkViolation("visit_vitals", "visit_vitals_check1");
    if ([v.temperature_c, v.spo2_percent, v.bp_systolic, v.height_cm, v.weight_kg].every((x) => x === null))
      checkViolation("visit_vitals", "visit_vitals_check2");
    if (v.notes && v.notes.length > 1000) checkViolation("visit_vitals", "visit_vitals_notes_check");
  };

  const checkRating = (r: RatingInput) => {
    const between = (v: number | null, col: string) => {
      if (v !== null && (v < 1 || v > 5)) checkViolation("clinician_ratings", `clinician_ratings_${col}_check`);
    };
    if (r.rating < 1 || r.rating > 5) checkViolation("clinician_ratings", "clinician_ratings_rating_check");
    between(r.rating_communication, "rating_communication");
    between(r.rating_wait_time, "rating_wait_time");
    if (r.comment && r.comment.length > 2000) checkViolation("clinician_ratings", "clinician_ratings_comment_check");
  };

  // public.can_rate_appointment
  const canRate = (appointmentId: Uuid) => {
    const a = appointmentById(appointmentId);
    const cutoff = new Date(now().getTime() - 30 * 86_400_000).toISOString();
    return !!a && a.patient_id === ctx().patientId && a.status === "completed" && (a.consult_ended_at ?? "") > cutoff;
  };

  // insurance_claims_before_write
  const resolveClaimPolicy = (appointmentId: Uuid, policyId: Uuid | null) => {
    const a = appointmentById(appointmentId);
    if (!a) fail('insert or update on table "insurance_claims" violates foreign key constraint', "23503");
    const pid = policyId ?? a!.patient_insurance_policy_id;
    if (!pid) fail("Patient had no insurance policy on the visit date", "23514");
    const day = localDate(a!.scheduled_start, facilityTz(state, a!.facility_id));
    const ok = state.patient_insurance_policies.some((p) => p.id === pid && p.patient_id === a!.patient_id && validOn(p, day));
    if (!ok) fail("Policy does not belong to this patient or was not valid on the visit date", "23514");
    return pid!;
  };

  const sortBy = <T>(rows: T[], key: (r: T) => string | number, desc = false) =>
    [...rows].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return (ka < kb ? -1 : ka > kb ? 1 : 0) * (desc ? -1 : 1);
    });

  // ---------------------------------------------------------------------------
  // The API
  // ---------------------------------------------------------------------------
  const api: DataApi = {
    async whoami(): Promise<Me | null> {
      if (!uid || !state.users.some((u) => u.id === uid)) return null;
      const c = ctx();
      return {
        userId: c.uid,
        email: c.email,
        appRole: c.appRole,
        signupRole: c.signupRole,
        patient: clone(state.patients.find((p) => p.id === c.patientId) ?? null),
        clinician: clone(state.clinicians.find((x) => x.id === c.clinicianId) ?? null),
      };
    },

    // reference / directory
    async listResidencyStatuses() {
      ctx();
      return sortBy(state.residency_statuses, (r) => r.name).map(clone);
    },
    async listInsuranceProviders() {
      ctx();
      return sortBy(state.insurance_providers, (r) => r.name).map(clone);
    },
    async listInsurancePlans() {
      ctx();
      return sortBy(state.insurance_plans, (r) => r.plan_name).map(clone);
    },
    async listFacilities() {
      ctx();
      return sortBy(state.facilities, (r) => r.name).map(clone);
    },
    async listBillingPolicies() {
      ctx();
      return state.facility_billing_policies.map(clone);
    },
    async listClinicians() {
      ctx();
      return sortBy(state.clinicians, (r) => `${r.last_name} ${r.first_name}`).map(clone);
    },
    async listQualifications(clinicianId) {
      ctx();
      return state.clinician_qualifications.filter((q) => !clinicianId || q.clinician_id === clinicianId).map(clone);
    },
    async listRegistrations(clinicianId) {
      ctx();
      return sortBy(
        state.clinician_registrations.filter((q) => !clinicianId || q.clinician_id === clinicianId),
        (r) => r.valid_from,
        true,
      ).map(clone);
    },
    async listAffiliations(clinicianId) {
      ctx();
      return state.clinician_affiliations.filter((q) => !clinicianId || q.clinician_id === clinicianId).map(clone);
    },
    async listSchedules(filter = {}) {
      ctx();
      return sortBy(
        state.clinician_schedules.filter(
          (s) =>
            (!filter.clinicianId || s.clinician_id === filter.clinicianId) &&
            (!filter.facilityId || s.facility_id === filter.facilityId),
        ),
        (s) => `${s.weekday}${s.start_time}`,
      ).map(clone);
    },

    // patients
    async getPatient(id) {
      const p = state.patients.find((x) => x.id === id);
      return p && canSeePatient(p) ? clone(p) : null;
    },
    async createPatient(input) {
      const c = ctx();
      if (!(input.auth_user_id === c.uid || isStaff())) rls("patients");
      if (input.auth_user_id && state.patients.some((p) => p.auth_user_id === input.auth_user_id)) {
        fail('duplicate key value violates unique constraint "patients_auth_user_id_key"', "23505");
      }
      const at = nowIso();
      const row: Patient = {
        id: crypto.randomUUID(),
        auth_user_id: null,
        preferred_name: null,
        sex: null,
        gender_identity: null,
        email: null,
        phone: null,
        blood_type: null,
        medicare_number: null,
        medicare_irn: null,
        medicare_expiry: null,
        ihi_number: null,
        emergency_contact_name: null,
        emergency_contact_phone: null,
        emergency_contact_relationship: null,
        is_active: true,
        ...input,
        created_at: at,
        updated_at: at,
      };
      checkPatient(row);
      state.patients.push(row);
      return clone(row);
    },
    async updatePatient(id, patch) {
      const c = ctx();
      const p = state.patients.find((x) => x.id === id);
      if (!p || !(p.auth_user_id === c.uid || isStaff())) return notFound();
      const next = { ...p, ...patch, updated_at: nowIso() };
      checkPatient(next);
      Object.assign(p, next);
      return clone(p);
    },
    async searchPatients(query) {
      const q = query.trim().toLowerCase();
      const digits = q.replace(/\D/g, "");
      return state.patients
        .filter(canSeePatient)
        .filter(
          (p) =>
            !q ||
            `${p.first_name} ${p.last_name}`.toLowerCase().includes(q) ||
            (p.preferred_name ?? "").toLowerCase().includes(q) ||
            (p.email ?? "").toLowerCase().includes(q) ||
            p.date_of_birth === q ||
            (digits.length >= 4 && ((p.phone ?? "").replace(/\D/g, "").includes(digits) || (p.medicare_number ?? "").includes(digits))),
        )
        .slice(0, 25)
        .map(clone);
    },
    async listAddresses(patientId) {
      ctx();
      return sortBy(
        state.patient_addresses.filter((a) => a.patient_id === patientId && ownsPatientRow(a.patient_id)),
        (a) => a.valid_from,
        true,
      ).map(clone);
    },
    async changeAddress(patientId, input) {
      if (!ownsPatientRow(patientId)) rls("patient_addresses");
      const rows = state.patient_addresses;
      const current = currentOn(rows, (r) => r.patient_id === patientId && r.address_type === input.address_type);
      const at = nowIso();
      const row = replaceCurrent(
        "patient_addresses",
        rows,
        current,
        (validFrom) => ({
          id: crypto.randomUUID(),
          patient_id: patientId,
          ...input,
          address_line2: input.address_line2 || null,
          country: input.country || "Australia",
          valid_from: validFrom,
          valid_to: null,
          created_at: at,
          updated_at: at,
        }),
        (r) => r.patient_id === patientId && r.address_type === input.address_type,
      );
      return clone(row!);
    },
    async endAddress(patientId, addressType) {
      if (!ownsPatientRow(patientId)) rls("patient_addresses");
      const current = currentOn(state.patient_addresses, (r) => r.patient_id === patientId && r.address_type === addressType);
      if (!current) return;
      if (current.valid_from >= today()) checkViolation("patient_addresses", "patient_addresses_check");
      Object.assign(current, { valid_to: today(), updated_at: nowIso() });
    },
    async listResidency(patientId) {
      ctx();
      return sortBy(
        state.patient_residency.filter((a) => a.patient_id === patientId && ownsPatientRow(a.patient_id)),
        (a) => a.valid_from,
        true,
      ).map(clone);
    },
    async changeResidency(patientId, input) {
      if (!ownsPatientRow(patientId)) rls("patient_residency");
      if (!state.residency_statuses.some((r) => r.id === input.residency_status_id)) {
        fail('insert or update on table "patient_residency" violates foreign key constraint', "23503");
      }
      const rows = state.patient_residency;
      const current = currentOn(rows, (r) => r.patient_id === patientId);
      const at = nowIso();
      const row = replaceCurrent(
        "patient_residency",
        rows,
        current,
        (validFrom) => ({
          id: crypto.randomUUID(),
          patient_id: patientId,
          residency_status_id: input.residency_status_id,
          visa_grant_number: input.visa_grant_number || null,
          valid_from: validFrom,
          valid_to: null,
          created_at: at,
          updated_at: at,
        }),
        (r) => r.patient_id === patientId,
      );
      return clone(row!);
    },
    async listPolicies(patientId) {
      ctx();
      return sortBy(
        state.patient_insurance_policies.filter((a) => a.patient_id === patientId && ownsPatientRow(a.patient_id)),
        (a) => a.valid_from,
        true,
      ).map(clone);
    },
    async changePolicy(patientId, input) {
      if (!ownsPatientRow(patientId)) rls("patient_insurance_policies");
      const rows = state.patient_insurance_policies;
      const current = currentOn(rows, (r) => r.patient_id === patientId);
      if (input && !state.insurance_plans.some((p) => p.id === input.plan_id)) {
        fail('insert or update on table "patient_insurance_policies" violates foreign key constraint', "23503");
      }
      if (input && !input.membership_number.trim()) {
        fail('null value in column "membership_number" violates not-null constraint', "23502");
      }
      if (!input) {
        // "No private insurance": end the current policy today.
        if (!current) return null;
        if (current.valid_from >= today()) checkViolation("patient_insurance_policies", "patient_insurance_policies_check");
        Object.assign(current, { valid_to: today(), updated_at: nowIso() });
        return null;
      }
      const at = nowIso();
      const row = replaceCurrent(
        "patient_insurance_policies",
        rows,
        current,
        (validFrom) => ({
          id: crypto.randomUUID(),
          patient_id: patientId,
          ...input,
          valid_from: validFrom,
          valid_to: null,
          created_at: at,
          updated_at: at,
        }),
        (r) => r.patient_id === patientId,
      );
      return clone(row);
    },

    // booking RPCs
    async getAvailableSlots({ date, facilityId, clinicianId, clinicianType }) {
      ctx();
      const at = nowIso();
      const rows = state.appointment_slots.flatMap((s) => {
        const f = state.facilities.find((x) => x.id === s.facility_id)!;
        const c = state.clinicians.find((x) => x.id === s.clinician_id)!;
        const open = s.status === "available" || (s.status === "held" && (s.held_until ?? "") < at);
        if (!open || s.starts_at <= at || localDate(s.starts_at, f.timezone) !== date) return [];
        if ((facilityId && s.facility_id !== facilityId) || (clinicianId && s.clinician_id !== clinicianId)) return [];
        if (clinicianType && c.clinician_type !== clinicianType) return [];
        const local = new Intl.DateTimeFormat("sv-SE", {
          timeZone: f.timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hourCycle: "h23",
        })
          .format(new Date(s.starts_at))
          .replace(" ", "T");
        return [
          {
            slot_id: s.id,
            starts_at: s.starts_at,
            ends_at: s.ends_at,
            local_start: local,
            clinician_id: c.id,
            clinician_name: `${c.first_name} ${c.last_name}`,
            clinician_type: c.clinician_type,
            specialty: c.specialty,
            facility_id: f.id,
            facility_name: f.name,
            facility_tz: f.timezone,
            _sort: `${f.name}|${c.last_name}|${s.starts_at}`,
          },
        ];
      });
      return sortBy(rows, (r) => r._sort).map(({ _sort, ...r }) => (void _sort, r));
    },
    async holdSlot(slotId) {
      const c = ctx();
      if (!c.patientId) fail("Only patients can hold slots", "42501");
      const at = nowIso();
      const s = state.appointment_slots.find(
        (x) =>
          x.id === slotId &&
          x.starts_at > at &&
          (x.status === "available" ||
            (x.status === "held" && ((x.held_until ?? "") < at || x.held_by_patient_id === c.patientId))),
      );
      if (!s) return fail("Slot is no longer available");
      const until = new Date(now().getTime() + 5 * 60_000).toISOString();
      Object.assign(s, { status: "held", held_by_patient_id: c.patientId, held_until: until, updated_at: at });
      return until;
    },
    async bookSlot({ slotId, reason = null, visitType = null, channel = "web", patientId = null }) {
      const c = ctx();
      let patient: Uuid;
      if (patientId) {
        if (!isStaff()) fail("Only staff can book for another patient", "42501");
        patient = patientId;
      } else {
        if (!c.patientId) fail("No patient profile for this user", "42501");
        patient = c.patientId!;
      }
      return bookSlotFor(slotId, patient, channel, reason, visitType);
    },
    async cancelAppointment(id, reason = null) {
      const c = ctx();
      const a = appointmentById(id);
      if (!a) return fail("Appointment not found");
      const allowed =
        isStaff() || a.clinician_id === c.clinicianId || (a.patient_id === c.patientId && a.scheduled_start > nowIso());
      if (!allowed) fail("Not allowed to cancel this appointment", "42501");
      setStatus(a, "cancelled", { cancellation_reason: reason, cancelled_by: uid });
    },
    async rescheduleAppointment(id, newSlotId) {
      const c = ctx();
      const a = appointmentById(id);
      if (!a) return fail("Appointment not found");
      if (!(isStaff() || (a.patient_id === c.patientId && a.scheduled_start > nowIso()))) {
        fail("Not allowed to reschedule this appointment", "42501");
      }
      if (!NEXT_STATUS[a.status].includes("rescheduled")) {
        fail(`Invalid appointment status change: ${a.status} -> rescheduled`, "23514");
      }
      const newId = bookSlotFor(newSlotId, a.patient_id, a.booking_channel, a.reason, a.visit_type);
      setStatus(a, "rescheduled", { rescheduled_to_appointment_id: newId });
      return newId;
    },

    // slots (table)
    async getSlot(id) {
      ctx();
      return clone(state.appointment_slots.find((s) => s.id === id) ?? null);
    },
    async listSlots({ clinicianId, facilityId, from, to }) {
      ctx();
      return sortBy(
        state.appointment_slots.filter(
          (s) =>
            s.starts_at >= from &&
            s.starts_at < to &&
            (!clinicianId || s.clinician_id === clinicianId) &&
            (!facilityId || s.facility_id === facilityId),
        ),
        (s) => s.starts_at,
      ).map(clone);
    },
    async setSlotBlocked(id, blocked) {
      requireStaff("appointment_slots");
      const s = state.appointment_slots.find((x) => x.id === id && x.status === (blocked ? "available" : "blocked"));
      if (!s) return notFound();
      Object.assign(s, { status: blocked ? "blocked" : "available", updated_at: nowIso() });
      return clone(s);
    },

    // appointments
    async listAppointments(filter: AppointmentFilter = {}) {
      ctx();
      const rows = state.appointments.filter(
        (a) =>
          canSeeAppointment(a) &&
          (!filter.patientId || a.patient_id === filter.patientId) &&
          (!filter.clinicianId || a.clinician_id === filter.clinicianId) &&
          (!filter.facilityId || a.facility_id === filter.facilityId) &&
          (!filter.from || a.scheduled_start >= filter.from) &&
          (!filter.to || a.scheduled_start < filter.to) &&
          (!filter.statuses || filter.statuses.includes(a.status)),
      );
      const sorted = sortBy(rows, (a) => a.scheduled_start, filter.ascending === false);
      return (filter.limit ? sorted.slice(0, filter.limit) : sorted).map(withRefs);
    },
    async getAppointment(id) {
      const a = appointmentById(id);
      return a && canSeeAppointment(a) ? withRefs(a) : null;
    },
    async updateAppointment(id, patch) {
      const c = ctx();
      const a = appointmentById(id);
      if (!a || !(a.clinician_id === c.clinicianId || isStaff())) return notFound();
      for (const k of ["fee_charged", "medicare_rebate", "gap_amount"] as const) {
        const v = patch[k];
        if (v !== undefined && v !== null && v < 0) checkViolation("appointments", `appointments_${k}_check`);
      }
      const { status, ...rest } = patch;
      if (status) setStatus(a, status, rest);
      else Object.assign(a, rest, { updated_at: nowIso() });
      return clone(a);
    },
    async listStatusHistory(appointmentId) {
      const a = appointmentById(appointmentId);
      if (!a || !canSeeAppointment(a)) return [];
      return sortBy(
        state.appointment_status_history.filter((h) => h.appointment_id === appointmentId),
        (h) => `${h.changed_at}|${String(h.id).padStart(8, "0")}`,
      ).map(clone);
    },

    // consent and recording
    async listConsents(appointmentId) {
      const a = appointmentById(appointmentId);
      if (!a || !canSeeAppointment(a)) return [];
      return state.recording_consents.filter((c) => c.appointment_id === appointmentId).map(clone);
    },
    async giveConsent(appointmentId, version, method = "in_app") {
      const c = ctx();
      const a = appointmentById(appointmentId);
      if (!a) return fail("Appointment not found");
      if (["completed", "cancelled", "no_show", "rescheduled"].includes(a.status)) {
        fail("Consent can only be given for an upcoming or current appointment");
      }
      const party =
        a.patient_id === c.patientId ? "patient" : a.clinician_id === c.clinicianId ? "clinician" : null;
      if (!party) return fail("Only the patient or clinician of this appointment can consent", "42501");
      if (!CONSENT_VERSIONS.has(version)) {
        fail('insert or update on table "recording_consents" violates foreign key constraint', "23503");
      }
      const at = nowIso();
      const existing = state.recording_consents.find((x) => x.appointment_id === appointmentId && x.party === party);
      if (existing) {
        Object.assign(existing, {
          consent_given: true,
          given_at: at,
          withdrawn_at: null,
          withdrawal_reason: null,
          consent_text_version: version,
          method,
          updated_at: at,
        });
        return existing.id;
      }
      const id = nextId(state, ID_PREFIX.consent);
      state.recording_consents.push({
        id,
        appointment_id: appointmentId,
        party,
        patient_id: party === "patient" ? a.patient_id : null,
        clinician_id: party === "clinician" ? a.clinician_id : null,
        consent_given: true,
        consent_text_version: version,
        method,
        given_at: at,
        withdrawn_at: null,
        withdrawal_reason: null,
        created_at: at,
        updated_at: at,
      });
      return id;
    },
    async withdrawConsent(appointmentId, reason = null) {
      const c = ctx();
      const a = appointmentById(appointmentId);
      const party = a && a.patient_id === c.patientId ? "patient" : a && a.clinician_id === c.clinicianId ? "clinician" : null;
      if (!a || !party) return fail("Not a participant of this appointment", "42501");
      const at = nowIso();
      for (const x of state.recording_consents) {
        if (x.appointment_id === appointmentId && x.party === party && !x.withdrawn_at) {
          Object.assign(x, { withdrawn_at: at, withdrawal_reason: reason, updated_at: at });
        }
      }
      state.consult_transcripts = state.consult_transcripts.filter((t) => t.appointment_id !== appointmentId);
      for (const s of state.recording_sessions.filter((x) => x.appointment_id === appointmentId)) {
        setSessionStatus(s.id, { status: "consent_withdrawn", audio_discarded_at: s.audio_discarded_at ?? at });
      }
    },
    async listRecordingSessions(appointmentIds) {
      ctx();
      return sortBy(
        state.recording_sessions.filter((s) => {
          const a = appointmentById(s.appointment_id);
          return !!a && canSeeAppointment(a) && (!appointmentIds || appointmentIds.includes(s.appointment_id));
        }),
        (s) => s.started_at,
        true,
      ).map(clone);
    },
    // transcribe-consult: start -> public.start_recording_session
    async transcribeStart(appointmentId) {
      const c = ctx();
      const a = appointmentById(appointmentId);
      if (!a) return fail("Appointment not found");
      if (!(a.patient_id === c.patientId || a.clinician_id === c.clinicianId)) {
        fail("Not a participant of this appointment", "42501");
      }
      if (a.status !== "checked_in" && a.status !== "in_consultation") {
        fail("Recording is only allowed during the consultation");
      }
      if (!recordingAllowed(appointmentId)) fail("Both patient and clinician must consent before recording", "42501");
      const at = nowIso();
      const id = crypto.randomUUID();
      state.recording_sessions.push({
        id,
        appointment_id: appointmentId,
        started_by: uid!,
        started_at: at,
        ended_at: null,
        duration_seconds: null,
        engine: null,
        engine_model: null,
        status: "started",
        audio_discarded_at: null,
        error_message: null,
        created_at: at,
        updated_at: at,
      });
      return { session_id: id };
    },
    // transcribe-consult: chunk. Mock mode never sends or keeps audio: the
    // "transcription" is a placeholder sentence; only its text is stored.
    async transcribeChunk(sessionId, seq, audio, durationSeconds): Promise<TranscribeChunkResult> {
      if (!Number.isInteger(seq) || seq < 1 || seq > 500) fail("seq must be 1-500", "400");
      if (!audio || !(audio as { size?: number }).size) fail("audio is required", "400");
      const s = checkChunkAllowed(sessionId, false);
      if (!recordingAllowed(s.appointment_id)) {
        setSessionStatus(sessionId, { status: "consent_withdrawn", ended_at: nowIso(), audio_discarded_at: nowIso() });
        return { status: "discarded", reason: "consent_withdrawn" };
      }
      const secs = durationSeconds ?? 0;
      const half = Math.round((secs / 2) * 100) / 100;
      const text = `[Mock transcript, part ${seq}: about ${Math.round(secs)} seconds of audio. Mock mode does not transcribe speech.]`;
      const segments: TranscriptSegment[] = [
        { speaker: "speaker_0", start_sec: 0, end_sec: half, text: `Part ${seq}, first speaker (mock).` },
        { speaker: "speaker_1", start_sec: half, end_sec: secs, text: `Part ${seq}, second speaker (mock).` },
      ];
      const at = nowIso();
      const row = {
        session_id: sessionId,
        seq,
        transcript_text: text,
        segments,
        duration_seconds: durationSeconds,
        engine: "mock-stt",
        engine_model: "mock",
        created_at: at,
      };
      const i = state.recording_session_chunks.findIndex((c) => c.session_id === sessionId && c.seq === seq);
      if (i >= 0) state.recording_session_chunks[i] = row;
      else state.recording_session_chunks.push(row);
      setSessionStatus(sessionId, { audio_discarded_at: at, engine: "mock-stt", engine_model: "mock" });
      return { status: "stored", seq };
    },
    // transcribe-consult: finish -> public.finalize_transcript_from_chunks
    async transcribeFinish(sessionId): Promise<TranscribeFinishResult> {
      const s = checkChunkAllowed(sessionId, true);
      const at = nowIso();
      const chunks = sortBy(
        state.recording_session_chunks.filter((c) => c.session_id === sessionId),
        (c) => c.seq,
      );
      if (chunks.length === 0) {
        setSessionStatus(sessionId, { status: "failed", error_message: "No audio was transcribed", ended_at: at, audio_discarded_at: s.audio_discarded_at ?? at });
        return { status: "discarded", reason: "no_speech_or_consent_withdrawn" };
      }
      let offset = 0;
      const segments: TranscriptSegment[] = [];
      for (const c of chunks) {
        const dur = c.duration_seconds ?? Math.max(0, ...(c.segments ?? []).map((x) => x.end_sec));
        for (const seg of c.segments ?? []) {
          segments.push({
            speaker: `c${c.seq}:${seg.speaker ?? "unknown"}`,
            chunk: c.seq,
            start_sec: Math.round((seg.start_sec + offset) * 100) / 100,
            end_sec: Math.round((seg.end_sec + offset) * 100) / 100,
            text: seg.text,
          });
        }
        offset += dur;
      }
      const text = chunks.map((c) => c.transcript_text.trim()).filter(Boolean).join(" ");
      if (!text) {
        setSessionStatus(sessionId, { status: "failed", error_message: "Recording contained no speech", ended_at: at, audio_discarded_at: s.audio_discarded_at ?? at });
        return { status: "discarded", reason: "no_speech_or_consent_withdrawn" };
      }
      // save_transcript_draft
      if (!recordingAllowed(s.appointment_id)) {
        setSessionStatus(sessionId, { status: "consent_withdrawn", audio_discarded_at: at, ended_at: at });
        return { status: "discarded", reason: "no_speech_or_consent_withdrawn" };
      }
      const transcript: ConsultTranscript = {
        id: crypto.randomUUID(),
        recording_session_id: sessionId,
        appointment_id: s.appointment_id,
        transcript_text: text,
        segments: segments.length ? segments : null,
        summary_text: null,
        language: "en-AU",
        status: "pending_patient_review",
        review_expires_at: new Date(now().getTime() + 7 * 86_400_000).toISOString(),
        approved_at: null,
        created_at: at,
        updated_at: at,
      };
      state.consult_transcripts.push(transcript);
      setSessionStatus(sessionId, {
        status: "awaiting_review",
        ended_at: at,
        audio_discarded_at: at,
        duration_seconds: Math.round(offset),
      });
      return { transcript_id: transcript.id, status: "pending_patient_review" };
    },
    // transcribe-consult: cancel -> public.mark_recording_failed
    async transcribeCancel(sessionId) {
      checkChunkAllowed(sessionId, true);
      const at = nowIso();
      const s = state.recording_sessions.find((x) => x.id === sessionId)!;
      if (s.status === "started") {
        setSessionStatus(sessionId, { status: "failed", error_message: "Cancelled by user", ended_at: at, audio_discarded_at: at });
      }
    },

    // transcripts: patient sees all of theirs; clinician only approved ones
    async listTranscripts(appointmentIds) {
      const c = ctx();
      return sortBy(
        state.consult_transcripts.filter((t) => {
          const a = appointmentById(t.appointment_id);
          if (!a || (appointmentIds && !appointmentIds.includes(a.id))) return false;
          return a.patient_id === c.patientId || (a.clinician_id === c.clinicianId && t.status === "approved");
        }),
        (t) => t.created_at,
        true,
      ).map(clone);
    },
    async getTranscript(id) {
      const [t] = (await api.listTranscripts()).filter((x) => x.id === id);
      return t ?? null;
    },
    async approveTranscript(id) {
      const c = ctx();
      const t = state.consult_transcripts.find((x) => x.id === id && appointmentById(x.appointment_id)?.patient_id === c.patientId);
      if (!t) return fail("Transcript not found", "42501");
      if (t.status !== "pending_patient_review") fail("Transcript is not awaiting review");
      if (t.review_expires_at < nowIso()) fail("Review window has expired");
      Object.assign(t, { status: "approved", approved_at: nowIso(), updated_at: nowIso() });
      setSessionStatus(t.recording_session_id, { status: "approved" });
    },
    async rejectTranscript(id) {
      const c = ctx();
      const t = state.consult_transcripts.find((x) => x.id === id && appointmentById(x.appointment_id)?.patient_id === c.patientId);
      if (!t) return fail("Transcript not found", "42501");
      if (t.status !== "pending_patient_review") fail("Only transcripts awaiting review can be rejected");
      state.consult_transcripts = state.consult_transcripts.filter((x) => x.id !== id);
      setSessionStatus(t.recording_session_id, { status: "rejected" });
    },

    // ratings
    async getRatingSummary(clinicianId) {
      ctx();
      const groups = new Map<Uuid, ClinicianRating[]>();
      for (const r of state.clinician_ratings) {
        if (r.moderation_status !== "visible" || (clinicianId && r.clinician_id !== clinicianId)) continue;
        groups.set(r.clinician_id, [...(groups.get(r.clinician_id) ?? []), r]);
      }
      const avg = (xs: (number | null)[], digits: number) => {
        const v = xs.filter((x): x is number => x !== null);
        return v.length ? Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10 ** digits) / 10 ** digits : null;
      };
      return [...groups].map(([id, rs]) => ({
        clinician_id: id,
        rating_count: rs.length,
        avg_rating: avg(rs.map((r) => r.rating), 2),
        avg_communication: avg(rs.map((r) => r.rating_communication), 2),
        avg_wait_time: avg(rs.map((r) => r.rating_wait_time), 2),
        pct_would_recommend: (() => {
          const v = avg(rs.map((r) => (r.would_recommend === null ? null : r.would_recommend ? 1 : 0)), 3);
          return v === null ? null : Math.round(v * 1000) / 10;
        })(),
      }));
    },
    async getMyRatingsAsClinician() {
      const c = ctx();
      const rows = state.clinician_ratings.filter((r) => r.clinician_id === c.clinicianId && r.moderation_status === "visible");
      return sortBy(
        rows.map((r) => {
          const a = appointmentById(r.appointment_id)!;
          const p = state.patients.find((x) => x.id === r.patient_id)!;
          return {
            rating_id: r.id,
            appointment_id: r.appointment_id,
            visit_date: a.scheduled_start,
            rating: r.rating,
            rating_communication: r.rating_communication,
            rating_wait_time: r.rating_wait_time,
            would_recommend: r.would_recommend,
            comment: r.comment,
            patient_display_name: r.is_anonymous ? null : `${p.preferred_name ?? p.first_name} ${p.last_name.slice(0, 1)}.`,
            created_at: r.created_at,
          };
        }),
        (r) => r.visit_date,
        true,
      );
    },
    async canRateAppointment(appointmentId) {
      ctx();
      return canRate(appointmentId);
    },
    async getRatingForAppointment(appointmentId) {
      const c = ctx();
      const r = state.clinician_ratings.find(
        (x) => x.appointment_id === appointmentId && (x.patient_id === c.patientId || isStaff()),
      );
      return clone(r ?? null);
    },
    async createRating(appointmentId, input) {
      const c = ctx();
      const a = appointmentById(appointmentId);
      if (!a || !canRate(appointmentId) || a.patient_id !== c.patientId) rls("clinician_ratings");
      if (state.clinician_ratings.some((r) => r.appointment_id === appointmentId)) {
        fail('duplicate key value violates unique constraint "clinician_ratings_appointment_id_key"', "23505");
      }
      checkRating(input);
      const at = nowIso();
      const row: ClinicianRating = {
        id: nextId(state, ID_PREFIX.rating),
        appointment_id: appointmentId,
        patient_id: a!.patient_id,
        clinician_id: a!.clinician_id,
        ...input,
        comment: input.comment?.trim() || null,
        moderation_status: "visible",
        created_at: at,
        updated_at: at,
      };
      state.clinician_ratings.push(row);
      return clone(row);
    },
    async updateRating(id, input) {
      const c = ctx();
      const r = state.clinician_ratings.find((x) => x.id === id);
      const cutoff = new Date(now().getTime() - 30 * 86_400_000).toISOString();
      if (!r || !(isStaff() || (r.patient_id === c.patientId && r.created_at > cutoff))) return notFound();
      checkRating(input);
      Object.assign(r, input, { comment: input.comment?.trim() || null, updated_at: nowIso() });
      return clone(r);
    },
    async listRatings(filter = {}): Promise<RatingWithRefs[]> {
      const c = ctx();
      return sortBy(
        state.clinician_ratings.filter(
          (r) =>
            (r.patient_id === c.patientId || isStaff()) &&
            (!filter.clinicianIds || filter.clinicianIds.includes(r.clinician_id)) &&
            (!filter.status || r.moderation_status === filter.status),
        ),
        (r) => r.created_at,
        true,
      ).map((r) => {
        const a = appointmentById(r.appointment_id);
        return {
          ...clone(r),
          appointment: a ? { id: a.id, scheduled_start: a.scheduled_start, facility_id: a.facility_id } : null,
        };
      });
    },
    async moderateRating(id, status) {
      const r = state.clinician_ratings.find((x) => x.id === id);
      if (!r || !isStaff()) return notFound();
      Object.assign(r, { moderation_status: status, updated_at: nowIso() });
    },

    // vitals
    async listVitals(appointmentId) {
      const c = ctx();
      const a = appointmentById(appointmentId);
      if (!a) return [];
      const visible = a.patient_id === c.patientId || isStaff() || a.clinician_id === c.clinicianId;
      if (!visible) return [];
      return sortBy(state.visit_vitals.filter((v) => v.appointment_id === appointmentId), (v) => v.recorded_at).map(clone);
    },
    async listVitalsLatest(patientId) {
      ctx();
      const out: VisitVitalsLatest[] = [];
      for (const a of state.appointments.filter((x) => x.patient_id === patientId && canSeeAppointment(x))) {
        const vs = sortBy(state.visit_vitals.filter((v) => v.appointment_id === a.id), (v) => v.recorded_at, true);
        if (!vs.length) continue;
        const latest = <K extends keyof VisitVitals>(k: K, when: keyof VisitVitals = k) =>
          (vs.find((v) => v[when] !== null)?.[k] ?? null) as VisitVitals[K] | null;
        out.push({
          appointment_id: a.id,
          patient_id: a.patient_id,
          visit_start: a.scheduled_start,
          temperature_c: latest("temperature_c"),
          spo2_percent: latest("spo2_percent"),
          bp_systolic: latest("bp_systolic"),
          bp_diastolic: latest("bp_diastolic", "bp_systolic"),
          height_cm: latest("height_cm"),
          weight_kg: latest("weight_kg"),
          bmi: latest("bmi"),
          last_recorded_at: vs[0].recorded_at,
        });
      }
      return sortBy(out, (v) => v.visit_start, true);
    },
    async addVitals(appointmentId, input) {
      const c = ctx();
      const a = appointmentById(appointmentId);
      if (!a || !(isStaff() || a.clinician_id === c.clinicianId)) return rls("visit_vitals");
      if (!["checked_in", "in_consultation", "completed"].includes(a.status)) {
        fail(`Vitals can only be recorded once the patient has checked in (status is ${a.status})`, "23514");
      }
      const at = nowIso();
      const row: VisitVitals = {
        id: nextId(state, ID_PREFIX.vitals),
        appointment_id: appointmentId,
        patient_id: a.patient_id,
        ...input,
        notes: input.notes?.trim() || null,
        bmi: computeBmi(input.height_cm, input.weight_kg),
        recorded_at: at,
        recorded_by: uid,
        created_at: at,
        updated_at: at,
      };
      checkVitals(row);
      state.visit_vitals.push(row);
      return clone(row);
    },

    // schedule exceptions (reasons private to the clinician and staff)
    async listExceptions(filter = {}) {
      const c = ctx();
      return sortBy(
        state.schedule_exceptions.filter(
          (e) =>
            (isStaff() || e.clinician_id === c.clinicianId) &&
            (!filter.clinicianId || e.clinician_id === filter.clinicianId) &&
            (!filter.from || e.ends_at > filter.from),
        ),
        (e) => e.starts_at,
      ).map(clone);
    },
    async addException(input) {
      const c = ctx();
      if (!(isStaff() || input.clinician_id === c.clinicianId)) rls("schedule_exceptions");
      if (input.ends_at <= input.starts_at) checkViolation("schedule_exceptions", "schedule_exceptions_check");
      if (input.slot_minutes !== null && (input.slot_minutes < 5 || input.slot_minutes > 240)) {
        checkViolation("schedule_exceptions", "schedule_exceptions_slot_minutes_check");
      }
      if (input.exception_type === "extra_session" && (!input.facility_id || !input.slot_minutes)) {
        checkViolation("schedule_exceptions", "schedule_exceptions_check1");
      }
      const at = nowIso();
      const row = { id: nextId(state, ID_PREFIX.exception), ...input, created_at: at, updated_at: at };
      state.schedule_exceptions.push(row);
      // schedule_exceptions_after_change
      if (row.exception_type === "extra_session") {
        generateSlots(state, row.starts_at.slice(0, 10), row.ends_at.slice(0, 10), now());
      }
      syncSlotBlocks(state, row.clinician_id, now());
      return clone(row);
    },
    async deleteException(id) {
      const c = ctx();
      const e = state.schedule_exceptions.find((x) => x.id === id && (isStaff() || x.clinician_id === c.clinicianId));
      if (!e) return;
      state.schedule_exceptions = state.schedule_exceptions.filter((x) => x.id !== id);
      for (const s of state.appointment_slots) if (s.source_exception_id === id) s.source_exception_id = null;
      syncSlotBlocks(state, e.clinician_id, now());
    },
    async addSchedule(input) {
      requireStaff("clinician_schedules");
      if (input.weekday < 1 || input.weekday > 7) checkViolation("clinician_schedules", "clinician_schedules_weekday_check");
      if (input.slot_minutes < 5 || input.slot_minutes > 240) checkViolation("clinician_schedules", "clinician_schedules_slot_minutes_check");
      if (input.end_time <= input.start_time) checkViolation("clinician_schedules", "clinician_schedules_check");
      if (input.valid_to && input.valid_to <= input.valid_from) checkViolation("clinician_schedules", "clinician_schedules_check1");
      const at = nowIso();
      const row = {
        id: nextId(state, ID_PREFIX.schedule),
        ...input,
        start_time: input.start_time.length === 5 ? `${input.start_time}:00` : input.start_time,
        end_time: input.end_time.length === 5 ? `${input.end_time}:00` : input.end_time,
        valid_to: input.valid_to ?? null,
        created_at: at,
        updated_at: at,
      };
      state.clinician_schedules.push(row);
      return clone(row);
    },
    async endSchedule(id, validTo) {
      requireStaff("clinician_schedules");
      const s = state.clinician_schedules.find((x) => x.id === id);
      if (!s) return notFound();
      if (validTo <= s.valid_from) checkViolation("clinician_schedules", "clinician_schedules_check1");
      Object.assign(s, { valid_to: validTo, updated_at: nowIso() });
    },

    // clinician administration
    async createClinician(input) {
      requireStaff("clinicians");
      if (input.ahpra_registration_number) {
        if (!RE.ahpra.test(input.ahpra_registration_number)) checkViolation("clinicians", "clinicians_ahpra_registration_number_check");
        if (state.clinicians.some((c) => c.ahpra_registration_number === input.ahpra_registration_number)) {
          fail('duplicate key value violates unique constraint "clinicians_ahpra_registration_number_key"', "23505");
        }
      }
      const at = nowIso();
      const row = {
        id: crypto.randomUUID(),
        auth_user_id: null,
        sex: null,
        email: null,
        phone: null,
        clinician_type: "gp" as const,
        specialty: null,
        ahpra_registration_number: null,
        is_active: true,
        ...input,
        created_at: at,
        updated_at: at,
      };
      state.clinicians.push(row);
      return clone(row);
    },
    async updateClinician(id, input) {
      const c = ctx();
      const row = state.clinicians.find((x) => x.id === id);
      if (!row || !(isStaff() || row.auth_user_id === c.uid)) return notFound();
      if (input.ahpra_registration_number) {
        if (!RE.ahpra.test(input.ahpra_registration_number)) checkViolation("clinicians", "clinicians_ahpra_registration_number_check");
        if (state.clinicians.some((x) => x.id !== id && x.ahpra_registration_number === input.ahpra_registration_number)) {
          fail('duplicate key value violates unique constraint "clinicians_ahpra_registration_number_key"', "23505");
        }
      }
      Object.assign(row, input, { updated_at: nowIso() });
      return clone(row);
    },
    async addQualification(clinicianId, input) {
      requireStaff("clinician_qualifications");
      if (input.year_awarded !== null && (input.year_awarded < 1900 || input.year_awarded > 2100)) {
        checkViolation("clinician_qualifications", "clinician_qualifications_year_awarded_check");
      }
      const at = nowIso();
      const row = { id: nextId(state, ID_PREFIX.qualification), clinician_id: clinicianId, ...input, created_at: at, updated_at: at };
      state.clinician_qualifications.push(row);
      return clone(row);
    },
    async updateQualification(id, input) {
      requireStaff("clinician_qualifications");
      const row = state.clinician_qualifications.find((x) => x.id === id);
      if (!row) return notFound();
      if (input.year_awarded !== null && (input.year_awarded < 1900 || input.year_awarded > 2100)) {
        checkViolation("clinician_qualifications", "clinician_qualifications_year_awarded_check");
      }
      Object.assign(row, input, { updated_at: nowIso() });
      return clone(row);
    },
    async addRegistration(clinicianId, input) {
      requireStaff("clinician_registrations");
      const rows = state.clinician_registrations.filter((r) => r.clinician_id === clinicianId);
      const open = rows.find((r) => r.valid_to === null);
      if (open) {
        if (input.valid_from <= open.valid_from) checkViolation("clinician_registrations", "clinician_registrations_check");
        Object.assign(open, { valid_to: input.valid_from, updated_at: nowIso() });
      }
      if (rows.some((r) => r !== open && rangesOverlap(r.valid_from, r.valid_to, input.valid_from, null))) {
        if (open) open.valid_to = null;
        exclusionViolation("clinician_registrations");
      }
      const at = nowIso();
      const row = {
        id: nextId(state, ID_PREFIX.registration),
        clinician_id: clinicianId,
        ...input,
        valid_to: null,
        created_at: at,
        updated_at: at,
      };
      state.clinician_registrations.push(row);
      return clone(row);
    },
    async addAffiliation(input) {
      requireStaff("clinician_affiliations");
      if (input.medicare_provider_number && !RE.provider.test(input.medicare_provider_number)) {
        checkViolation("clinician_affiliations", "clinician_affiliations_medicare_provider_number_check");
      }
      if (input.valid_to && input.valid_to <= input.valid_from) checkViolation("clinician_affiliations", "clinician_affiliations_check");
      const clash = state.clinician_affiliations.some(
        (a) =>
          a.clinician_id === input.clinician_id &&
          a.facility_id === input.facility_id &&
          rangesOverlap(a.valid_from, a.valid_to, input.valid_from, input.valid_to ?? null),
      );
      if (clash) exclusionViolation("clinician_affiliations");
      const at = nowIso();
      const row = { id: nextId(state, ID_PREFIX.affiliation), ...input, valid_to: input.valid_to ?? null, created_at: at, updated_at: at };
      state.clinician_affiliations.push(row);
      return clone(row);
    },
    async endAffiliation(id, validTo) {
      requireStaff("clinician_affiliations");
      const a = state.clinician_affiliations.find((x) => x.id === id);
      if (!a) return notFound();
      if (validTo <= a.valid_from) checkViolation("clinician_affiliations", "clinician_affiliations_check");
      Object.assign(a, { valid_to: validTo, updated_at: nowIso() });
    },

    // claims
    async listClaims(appointmentIds) {
      const c = ctx();
      return state.insurance_claims
        .filter((x) => {
          const a = appointmentById(x.appointment_id);
          return (
            (isStaff() || a?.patient_id === c.patientId) && (!appointmentIds || appointmentIds.includes(x.appointment_id))
          );
        })
        .map(clone);
    },
    async createClaim(input) {
      requireStaff("insurance_claims");
      if (input.amount_claimed < 0) checkViolation("insurance_claims", "insurance_claims_amount_claimed_check");
      if (input.claim_number && state.insurance_claims.some((x) => x.claim_number === input.claim_number)) {
        fail('duplicate key value violates unique constraint "insurance_claims_claim_number_key"', "23505");
      }
      const policy = resolveClaimPolicy(input.appointment_id, null);
      const at = nowIso();
      const status = input.status ?? "draft";
      const row = {
        id: nextId(state, ID_PREFIX.claim),
        appointment_id: input.appointment_id,
        patient_insurance_policy_id: policy,
        claim_number: input.claim_number || null,
        amount_claimed: input.amount_claimed,
        amount_approved: null,
        amount_paid: null,
        status,
        submitted_at: status === "submitted" ? at : null,
        processed_at: ["approved", "rejected", "paid"].includes(status) ? at : null,
        rejection_reason: null,
        created_at: at,
        updated_at: at,
      };
      state.insurance_claims.push(row);
      return clone(row);
    },
    async updateClaim(id, patch) {
      requireStaff("insurance_claims");
      const row = state.insurance_claims.find((x) => x.id === id);
      if (!row) return notFound();
      for (const k of ["amount_claimed", "amount_approved", "amount_paid"] as const) {
        const v = patch[k];
        if (v !== undefined && v !== null && v < 0) checkViolation("insurance_claims", `insurance_claims_${k}_check`);
      }
      if (patch.claim_number && state.insurance_claims.some((x) => x.id !== id && x.claim_number === patch.claim_number)) {
        fail('duplicate key value violates unique constraint "insurance_claims_claim_number_key"', "23505");
      }
      resolveClaimPolicy(row.appointment_id, row.patient_insurance_policy_id);
      const at = nowIso();
      Object.assign(row, patch, { updated_at: at });
      if (row.status === "submitted") row.submitted_at ??= at;
      if (["approved", "rejected", "paid"].includes(row.status)) row.processed_at ??= at;
      return clone(row);
    },
  };
  return api;
}

/** A shallow description used by the slot realtime poller in mock mode. */
export function slotSnapshot(state: MockState, clinicianId: Uuid): Pick<AppointmentSlot, "id" | "status" | "held_by_patient_id" | "held_until" | "clinician_id">[] {
  return state.appointment_slots
    .filter((s) => s.clinician_id === clinicianId && s.starts_at > new Date().toISOString())
    .map((s) => ({ id: s.id, status: s.status, held_by_patient_id: s.held_by_patient_id, held_until: s.held_until, clinician_id: s.clinician_id }));
}
