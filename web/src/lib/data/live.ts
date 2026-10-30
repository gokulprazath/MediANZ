// DataApi over supabase-js with the signed-in user's session: every query runs
// as `authenticated`, so the RLS policies in the SQL decide what comes back.
// Booking only ever goes through the RPCs (never direct writes to appointments
// or appointment_slots for booking).
import type { SupabaseClient } from "@supabase/supabase-js";
import { TRANSCRIBE_FUNCTION_URL, SUPABASE_ANON_KEY } from "@/lib/env";
import { todayUtc } from "@/lib/time";
import {
  CLINICIAN_SUMMARY_COLUMNS,
  FACILITY_SUMMARY_COLUMNS,
  PATIENT_SUMMARY_COLUMNS,
  type AddressType,
  type AppointmentWithRefs,
  type IsoDate,
  type Uuid,
} from "@/types/db";
import {
  DataError,
  type DataApi,
  type Me,
  type SlotChange,
  type SubscribeSlots,
  type TranscribeChunkResult,
  type TranscribeFinishResult,
} from "./api";

type Result<T> = { data: T | null; error: { message: string; code?: string; details?: string } | null };

function unwrap<T>({ data, error }: Result<T>): T {
  if (error) throw new DataError(error.message, error.code ?? null);
  return data as T;
}

const APPOINTMENT_SELECT = `*, patient:patients(${PATIENT_SUMMARY_COLUMNS}), clinician:clinicians(${CLINICIAN_SUMMARY_COLUMNS}), facility:facilities(${FACILITY_SUMMARY_COLUMNS})`;

function audioFileName(type: string): string {
  if (type.includes("webm")) return "chunk.webm";
  if (type.includes("ogg") || type.includes("opus")) return "chunk.ogg";
  if (type.includes("mp4") || type.includes("aac")) return "chunk.m4a";
  return "chunk";
}

export function createLiveApi(sb: SupabaseClient): DataApi {
  const today = () => todayUtc();

  async function accessToken(): Promise<string> {
    const { data } = await sb.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new DataError("You are signed out. Please sign in again.", "PGRST301", 401);
    return token;
  }

  // transcribe-consult Edge Function, called with the user's token.
  async function callTranscribe(body: FormData | Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!TRANSCRIBE_FUNCTION_URL) throw new DataError("Transcription is not configured.", "config");
    const isForm = body instanceof FormData;
    const res = await fetch(TRANSCRIBE_FUNCTION_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        apikey: SUPABASE_ANON_KEY,
        ...(isForm ? {} : { "Content-Type": "application/json" }),
      },
      body: isForm ? body : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    // 409 with {status: "discarded"} is an outcome, not a failure.
    if (res.ok || json.status === "discarded") return json;
    throw new DataError(String(json.error ?? `Transcription service returned ${res.status}`), String(res.status), res.status);
  }

  // History-aware tables: end the row in force today and add a new one from
  // today. A row that started today is corrected in place instead, because
  // valid_to must be after valid_from. Two requests (Part A has no RPC for
  // this); if the insert fails, the ended row is reopened.
  async function replaceCurrent<T extends { id: Uuid; valid_from: IsoDate; valid_to: IsoDate | null }>(
    table: string,
    match: Record<string, string>,
    values: Record<string, unknown> | null,
  ): Promise<T | null> {
    const t = today();
    let q = sb.from(table).select("*").lte("valid_from", t).or(`valid_to.is.null,valid_to.gt.${t}`);
    for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
    const current = unwrap(await q.maybeSingle()) as T | null;

    if (current && current.valid_from >= t) {
      if (!values) throw new DataError("This was added today, so it can be changed but not ended until tomorrow.", "23514");
      return unwrap(await sb.from(table).update(values).eq("id", current.id).select("*").single()) as T;
    }
    if (current) {
      unwrap(await sb.from(table).update({ valid_to: t }).eq("id", current.id).select("id").single());
    }
    if (!values) return null;
    const inserted = await sb.from(table).insert({ ...match, ...values, valid_from: t }).select("*").single();
    if (inserted.error && current) {
      await sb.from(table).update({ valid_to: current.valid_to }).eq("id", current.id);
    }
    return unwrap(inserted) as T;
  }

  const api: DataApi = {
    async whoami(): Promise<Me | null> {
      const { data, error } = await sb.auth.getUser();
      if (error || !data.user) return null;
      const user = data.user;
      const [patient, clinician] = await Promise.all([
        sb.from("patients").select("*").eq("auth_user_id", user.id).maybeSingle(),
        sb.from("clinicians").select("*").eq("auth_user_id", user.id).maybeSingle(),
      ]);
      const role = user.app_metadata?.role;
      return {
        userId: user.id,
        email: user.email ?? null,
        appRole: role === "staff" || role === "admin" ? role : null,
        signupRole: (user.user_metadata?.signup_role as string | undefined) ?? null,
        patient: unwrap(patient),
        clinician: unwrap(clinician),
      };
    },

    // reference / directory
    async listResidencyStatuses() {
      return unwrap(await sb.from("residency_statuses").select("*").order("name"));
    },
    async listInsuranceProviders() {
      return unwrap(await sb.from("insurance_providers").select("*").order("name"));
    },
    async listInsurancePlans() {
      return unwrap(await sb.from("insurance_plans").select("*").order("plan_name"));
    },
    async listFacilities() {
      return unwrap(await sb.from("facilities").select("*").order("name"));
    },
    async listBillingPolicies() {
      return unwrap(await sb.from("facility_billing_policies").select("*"));
    },
    async listClinicians() {
      return unwrap(await sb.from("clinicians").select("*").order("last_name").order("first_name"));
    },
    async listQualifications(clinicianId) {
      let q = sb.from("clinician_qualifications").select("*");
      if (clinicianId) q = q.eq("clinician_id", clinicianId);
      return unwrap(await q);
    },
    async listRegistrations(clinicianId) {
      let q = sb.from("clinician_registrations").select("*").order("valid_from", { ascending: false });
      if (clinicianId) q = q.eq("clinician_id", clinicianId);
      return unwrap(await q);
    },
    async listAffiliations(clinicianId) {
      let q = sb.from("clinician_affiliations").select("*");
      if (clinicianId) q = q.eq("clinician_id", clinicianId);
      return unwrap(await q);
    },
    async listSchedules(filter = {}) {
      let q = sb.from("clinician_schedules").select("*").order("weekday").order("start_time");
      if (filter.clinicianId) q = q.eq("clinician_id", filter.clinicianId);
      if (filter.facilityId) q = q.eq("facility_id", filter.facilityId);
      return unwrap(await q);
    },

    // patients
    async getPatient(id) {
      return unwrap(await sb.from("patients").select("*").eq("id", id).maybeSingle());
    },
    async createPatient(input) {
      return unwrap(await sb.from("patients").insert(input).select("*").single());
    },
    async updatePatient(id, patch) {
      return unwrap(await sb.from("patients").update(patch).eq("id", id).select("*").single());
    },
    async searchPatients(query) {
      const q = query.trim().replace(/[,()*%]/g, " ").trim();
      let req = sb.from("patients").select("*").order("last_name").limit(25);
      if (q) {
        const digits = q.replace(/\D/g, "");
        const parts = [`first_name.ilike.%${q}%`, `last_name.ilike.%${q}%`, `preferred_name.ilike.%${q}%`, `email.ilike.%${q}%`];
        if (/^\d{4}-\d{2}-\d{2}$/.test(q)) parts.push(`date_of_birth.eq.${q}`);
        if (digits.length >= 4) parts.push(`phone.ilike.%${digits}%`, `medicare_number.ilike.%${digits}%`);
        const [first, ...rest] = q.split(/\s+/);
        if (rest.length) parts.push(`and(first_name.ilike.%${first}%,last_name.ilike.%${rest.join(" ")}%)`);
        req = req.or(parts.join(","));
      }
      return unwrap(await req);
    },
    async listAddresses(patientId) {
      return unwrap(
        await sb.from("patient_addresses").select("*").eq("patient_id", patientId).order("valid_from", { ascending: false }),
      );
    },
    async changeAddress(patientId, input) {
      const { address_type, ...rest } = input;
      return (await replaceCurrent("patient_addresses", { patient_id: patientId, address_type }, {
        ...rest,
        address_line2: rest.address_line2 || null,
        country: rest.country || "Australia",
      }))!;
    },
    async endAddress(patientId, addressType: AddressType) {
      await replaceCurrent("patient_addresses", { patient_id: patientId, address_type: addressType }, null);
    },
    async listResidency(patientId) {
      return unwrap(
        await sb.from("patient_residency").select("*").eq("patient_id", patientId).order("valid_from", { ascending: false }),
      );
    },
    async changeResidency(patientId, input) {
      return (await replaceCurrent("patient_residency", { patient_id: patientId }, {
        residency_status_id: input.residency_status_id,
        visa_grant_number: input.visa_grant_number || null,
      }))!;
    },
    async listPolicies(patientId) {
      return unwrap(
        await sb
          .from("patient_insurance_policies")
          .select("*")
          .eq("patient_id", patientId)
          .order("valid_from", { ascending: false }),
      );
    },
    async changePolicy(patientId, input) {
      return replaceCurrent("patient_insurance_policies", { patient_id: patientId }, input ? { ...input } : null);
    },

    // booking RPCs
    async getAvailableSlots({ date, facilityId = null, clinicianId = null, clinicianType = null }) {
      return unwrap(
        await sb.rpc("get_available_slots", {
          p_date: date,
          p_facility_id: facilityId,
          p_clinician_id: clinicianId,
          p_clinician_type: clinicianType,
        }),
      );
    },
    async holdSlot(slotId) {
      return unwrap(await sb.rpc("hold_slot", { p_slot_id: slotId }));
    },
    async bookSlot({ slotId, reason = null, visitType = null, channel = "web", patientId = null }) {
      return unwrap(
        await sb.rpc("book_slot", {
          p_slot_id: slotId,
          p_reason: reason,
          p_visit_type: visitType,
          p_channel: channel,
          p_patient_id: patientId,
        }),
      );
    },
    async cancelAppointment(id, reason = null) {
      unwrap(await sb.rpc("cancel_appointment", { p_appointment_id: id, p_reason: reason }));
    },
    async rescheduleAppointment(id, newSlotId) {
      return unwrap(await sb.rpc("reschedule_appointment", { p_appointment_id: id, p_new_slot_id: newSlotId }));
    },
    async confirmBookingProposal(id) {
      return unwrap(await sb.rpc("confirm_booking_proposal", { p_proposal_id: id }));
    },
    async declineBookingProposal(id) {
      unwrap(await sb.rpc("decline_booking_proposal", { p_proposal_id: id }));
    },

    // slots
    async getSlot(id) {
      return unwrap(await sb.from("appointment_slots").select("*").eq("id", id).maybeSingle());
    },
    async listSlots({ clinicianId, facilityId, from, to }) {
      let q = sb.from("appointment_slots").select("*").gte("starts_at", from).lt("starts_at", to).order("starts_at");
      if (clinicianId) q = q.eq("clinician_id", clinicianId);
      if (facilityId) q = q.eq("facility_id", facilityId);
      return unwrap(await q);
    },
    async setSlotBlocked(id, blocked) {
      // Only available <-> blocked; booked and held slots are never touched.
      return unwrap(
        await sb
          .from("appointment_slots")
          .update({ status: blocked ? "blocked" : "available" })
          .eq("id", id)
          .eq("status", blocked ? "available" : "blocked")
          .select("*")
          .single(),
      );
    },

    // appointments
    async listAppointments(filter = {}) {
      let q = sb
        .from("appointments")
        .select(APPOINTMENT_SELECT)
        .order("scheduled_start", { ascending: filter.ascending !== false });
      if (filter.patientId) q = q.eq("patient_id", filter.patientId);
      if (filter.clinicianId) q = q.eq("clinician_id", filter.clinicianId);
      if (filter.facilityId) q = q.eq("facility_id", filter.facilityId);
      if (filter.from) q = q.gte("scheduled_start", filter.from);
      if (filter.to) q = q.lt("scheduled_start", filter.to);
      if (filter.statuses) q = q.in("status", filter.statuses);
      if (filter.limit) q = q.limit(filter.limit);
      return unwrap(await q) as unknown as AppointmentWithRefs[];
    },
    async getAppointment(id) {
      return unwrap(await sb.from("appointments").select(APPOINTMENT_SELECT).eq("id", id).maybeSingle()) as unknown as
        | AppointmentWithRefs
        | null;
    },
    async updateAppointment(id, patch) {
      return unwrap(await sb.from("appointments").update(patch).eq("id", id).select("*").single());
    },
    async listStatusHistory(appointmentId) {
      return unwrap(
        await sb
          .from("appointment_status_history")
          .select("*")
          .eq("appointment_id", appointmentId)
          .order("changed_at")
          .order("id"),
      );
    },

    // consent and recording
    async listConsents(appointmentId) {
      return unwrap(await sb.from("recording_consents").select("*").eq("appointment_id", appointmentId));
    },
    async giveConsent(appointmentId, version, method = "in_app") {
      return unwrap(
        await sb.rpc("give_recording_consent", {
          p_appointment_id: appointmentId,
          p_consent_text_version: version,
          p_method: method,
        }),
      );
    },
    async withdrawConsent(appointmentId, reason = null) {
      unwrap(await sb.rpc("withdraw_recording_consent", { p_appointment_id: appointmentId, p_reason: reason }));
    },
    async listRecordingSessions(appointmentIds) {
      let q = sb.from("recording_sessions").select("*").order("started_at", { ascending: false });
      if (appointmentIds) q = q.in("appointment_id", appointmentIds);
      return unwrap(await q);
    },
    async transcribeStart(appointmentId) {
      const json = await callTranscribe({ action: "start", appointment_id: appointmentId });
      return { session_id: String(json.session_id) };
    },
    async transcribeChunk(sessionId, seq, audio, durationSeconds): Promise<TranscribeChunkResult> {
      const form = new FormData();
      form.append("action", "chunk");
      form.append("session_id", sessionId);
      form.append("seq", String(seq));
      form.append("audio", audio, audioFileName(audio.type));
      if (durationSeconds !== null) form.append("duration_seconds", String(Math.round(durationSeconds * 100) / 100));
      return (await callTranscribe(form)) as unknown as TranscribeChunkResult;
    },
    async transcribeFinish(sessionId): Promise<TranscribeFinishResult> {
      return (await callTranscribe({ action: "finish", session_id: sessionId })) as unknown as TranscribeFinishResult;
    },
    async transcribeCancel(sessionId) {
      await callTranscribe({ action: "cancel", session_id: sessionId });
    },

    // transcripts
    async listTranscripts(appointmentIds) {
      let q = sb.from("consult_transcripts").select("*").order("created_at", { ascending: false });
      if (appointmentIds) q = q.in("appointment_id", appointmentIds);
      return unwrap(await q);
    },
    async getTranscript(id) {
      return unwrap(await sb.from("consult_transcripts").select("*").eq("id", id).maybeSingle());
    },
    async approveTranscript(id) {
      unwrap(await sb.rpc("approve_transcript", { p_transcript_id: id }));
    },
    async rejectTranscript(id) {
      unwrap(await sb.rpc("reject_transcript", { p_transcript_id: id }));
    },

    // ratings
    async getRatingSummary(clinicianId = null) {
      return unwrap(await sb.rpc("get_clinician_rating_summary", { p_clinician_id: clinicianId }));
    },
    async getMyRatingsAsClinician() {
      return unwrap(await sb.rpc("get_my_ratings_as_clinician"));
    },
    async canRateAppointment(appointmentId) {
      return unwrap(await sb.rpc("can_rate_appointment", { p_appointment_id: appointmentId }));
    },
    async getRatingForAppointment(appointmentId) {
      return unwrap(await sb.from("clinician_ratings").select("*").eq("appointment_id", appointmentId).maybeSingle());
    },
    async createRating(appointmentId, input) {
      // patient_id and clinician_id are filled from the appointment by the
      // trigger; patient_id is sent so the RLS check sees the caller's own id.
      const me = await api.whoami();
      return unwrap(
        await sb
          .from("clinician_ratings")
          .insert({ ...input, appointment_id: appointmentId, patient_id: me?.patient?.id })
          .select("*")
          .single(),
      );
    },
    async updateRating(id, input) {
      return unwrap(await sb.from("clinician_ratings").update(input).eq("id", id).select("*").single());
    },
    async listRatings(filter = {}) {
      let q = sb
        .from("clinician_ratings")
        .select("*, appointment:appointments(id, scheduled_start, facility_id)")
        .order("created_at", { ascending: false });
      if (filter.clinicianIds) q = q.in("clinician_id", filter.clinicianIds);
      if (filter.status) q = q.eq("moderation_status", filter.status);
      return unwrap(await q);
    },
    async moderateRating(id, status) {
      unwrap(await sb.from("clinician_ratings").update({ moderation_status: status }).eq("id", id).select("id").single());
    },

    // vitals
    async listVitals(appointmentId) {
      return unwrap(await sb.from("visit_vitals").select("*").eq("appointment_id", appointmentId).order("recorded_at"));
    },
    async listVitalsLatest(patientId) {
      return unwrap(
        await sb.from("visit_vitals_latest").select("*").eq("patient_id", patientId).order("visit_start", { ascending: false }),
      );
    },
    async addVitals(appointmentId, input) {
      // patient_id is filled from the appointment by visit_vitals_before_write.
      const appt = unwrap(await sb.from("appointments").select("patient_id").eq("id", appointmentId).single()) as {
        patient_id: Uuid;
      };
      return unwrap(
        await sb
          .from("visit_vitals")
          .insert({ ...input, appointment_id: appointmentId, patient_id: appt.patient_id })
          .select("*")
          .single(),
      );
    },

    // schedules and exceptions
    async listExceptions(filter = {}) {
      let q = sb.from("schedule_exceptions").select("*").order("starts_at");
      if (filter.clinicianId) q = q.eq("clinician_id", filter.clinicianId);
      if (filter.from) q = q.gt("ends_at", filter.from);
      return unwrap(await q);
    },
    async addException(input) {
      return unwrap(await sb.from("schedule_exceptions").insert(input).select("*").single());
    },
    async deleteException(id) {
      unwrap(await sb.from("schedule_exceptions").delete().eq("id", id));
    },
    async addSchedule(input) {
      return unwrap(await sb.from("clinician_schedules").insert(input).select("*").single());
    },
    async endSchedule(id, validTo) {
      unwrap(await sb.from("clinician_schedules").update({ valid_to: validTo }).eq("id", id).select("id").single());
    },

    // clinician administration
    async createClinician(input) {
      return unwrap(await sb.from("clinicians").insert(input).select("*").single());
    },
    async updateClinician(id, input) {
      return unwrap(await sb.from("clinicians").update(input).eq("id", id).select("*").single());
    },
    async addQualification(clinicianId, input) {
      return unwrap(
        await sb.from("clinician_qualifications").insert({ ...input, clinician_id: clinicianId }).select("*").single(),
      );
    },
    async updateQualification(id, input) {
      return unwrap(await sb.from("clinician_qualifications").update(input).eq("id", id).select("*").single());
    },
    async addRegistration(clinicianId, input) {
      // End the open registration on the new row's start date, then add it.
      const open = unwrap(
        await sb.from("clinician_registrations").select("*").eq("clinician_id", clinicianId).is("valid_to", null).maybeSingle(),
      ) as { id: Uuid } | null;
      if (open) {
        unwrap(
          await sb.from("clinician_registrations").update({ valid_to: input.valid_from }).eq("id", open.id).select("id").single(),
        );
      }
      const inserted = await sb
        .from("clinician_registrations")
        .insert({ ...input, clinician_id: clinicianId })
        .select("*")
        .single();
      if (inserted.error && open) {
        await sb.from("clinician_registrations").update({ valid_to: null }).eq("id", open.id);
      }
      return unwrap(inserted);
    },
    async addAffiliation(input) {
      return unwrap(await sb.from("clinician_affiliations").insert(input).select("*").single());
    },
    async endAffiliation(id, validTo) {
      unwrap(await sb.from("clinician_affiliations").update({ valid_to: validTo }).eq("id", id).select("id").single());
    },

    // claims
    async listClaims(appointmentIds) {
      let q = sb.from("insurance_claims").select("*").order("created_at", { ascending: false });
      if (appointmentIds) q = q.in("appointment_id", appointmentIds);
      return unwrap(await q);
    },
    async createClaim(input) {
      // patient_insurance_policy_id is left out: the trigger fills it from the visit.
      return unwrap(await sb.from("insurance_claims").insert(input).select("*").single());
    },
    async updateClaim(id, patch) {
      return unwrap(await sb.from("insurance_claims").update(patch).eq("id", id).select("*").single());
    },

    // Part B
    async patientCheckIn(appointmentId) {
      unwrap(await sb.rpc("patient_check_in", { p_appointment_id: appointmentId }));
    },

    // agent layer (RLS decides which rows come back)
    async listDecisionQuestions() {
      return unwrap(await sb.from("decision_questions").select("*").order("id"));
    },
    async listClinicalFields() {
      return unwrap(await sb.from("clinical_fields").select("*").order("id"));
    },
    async listKeyPoints(filter = {}) {
      let q = sb.from("consult_key_points").select("*").order("created_at", { ascending: false });
      if (filter.appointmentIds) q = q.in("appointment_id", filter.appointmentIds);
      if (filter.statuses) q = q.in("status", filter.statuses);
      return unwrap(await q);
    },
    async listClinicalFacts(filter = {}) {
      let q = sb.from("clinical_facts").select("*").order("created_at", { ascending: false });
      if (filter.appointmentIds) q = q.in("appointment_id", filter.appointmentIds);
      if (filter.patientId) q = q.eq("patient_id", filter.patientId);
      if (filter.statuses) q = q.in("status", filter.statuses);
      return unwrap(await q);
    },
    async listOpenItems(filter = {}) {
      let q = sb.from("open_items").select("*").order("created_at", { ascending: false });
      if (filter.appointmentIds) q = q.in("appointment_id", filter.appointmentIds);
      if (filter.statuses) q = q.in("status", filter.statuses);
      return unwrap(await q);
    },
    async listGpQueries(filter = {}) {
      let q = sb.from("gp_queries").select("*").order("created_at", { ascending: false });
      if (filter.appointmentIds) q = q.in("appointment_id", filter.appointmentIds);
      if (filter.statuses) q = q.in("status", filter.statuses);
      return unwrap(await q);
    },
    async listTranscriptSegments(appointmentId) {
      return unwrap(
        await sb.from("transcript_segments").select("*").eq("appointment_id", appointmentId).order("seq"),
      );
    },
    async listConsultNoteRuns(appointmentIds) {
      let q = sb.from("consult_note_runs").select("*").order("queued_at", { ascending: false });
      if (appointmentIds) q = q.in("appointment_id", appointmentIds);
      return unwrap(await q);
    },
    async approveKeyPoint(id) {
      unwrap(await sb.rpc("approve_key_point", { p_key_point_id: id }));
    },
    async editAndApproveKeyPoint(id, answer) {
      unwrap(await sb.rpc("edit_and_approve_key_point", { p_key_point_id: id, p_answer: answer }));
    },
    async editAndApproveKeyPointText(id, text) {
      unwrap(await sb.rpc("edit_and_approve_key_point_text", { p_key_point_id: id, p_text: text }));
    },
    async rejectKeyPoint(id) {
      unwrap(await sb.rpc("reject_key_point", { p_key_point_id: id }));
    },
    async approveFact(id) {
      unwrap(await sb.rpc("approve_fact", { p_fact_id: id }));
    },
    async editAndApproveFact(id, value) {
      unwrap(await sb.rpc("edit_and_approve_fact", { p_fact_id: id, p_value: value }));
    },
    async rejectFact(id) {
      unwrap(await sb.rpc("reject_fact", { p_fact_id: id }));
    },
    async resolveOpenItem(id, resolution) {
      unwrap(await sb.rpc("resolve_open_item", { p_open_item_id: id, p_resolution: resolution }));
    },
    async answerGpQuery(id, answer) {
      unwrap(await sb.rpc("answer_gp_query", { p_gp_query_id: id, p_answer: answer }));
    },

    // operations
    async getAgentActivity(hours = 24) {
      return unwrap(await sb.rpc("get_agent_activity", { p_hours: hours }));
    },
    async getEngineActivity(hours = 24) {
      return unwrap(await sb.rpc("get_engine_activity", { p_hours: hours }));
    },
    async listModelRegistry() {
      return unwrap(await sb.from("model_registry").select("*").order("engine"));
    },
  };
  return api;
}

export function createLiveSlotSubscription(sb: SupabaseClient): SubscribeSlots {
  return (clinicianId, onChange) => {
    const channel = sb
      .channel(`appointment_slots:${clinicianId}:${crypto.randomUUID()}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "appointment_slots", filter: `clinician_id=eq.${clinicianId}` },
        (payload) => {
          const slot = (payload.new ?? payload.old) as SlotChange["slot"];
          if (slot?.id) onChange({ slot });
        },
      )
      .subscribe();
    return () => {
      void sb.removeChannel(channel);
    };
  };
}
