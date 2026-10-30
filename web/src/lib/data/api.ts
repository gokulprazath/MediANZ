// The one data interface every screen uses. Two implementations:
//   live.ts         supabase-js with the signed-in user's session (RLS applies)
//   mock (remote)   the in-memory mock database built from supabase/seed/
// Methods map 1:1 to a table read/write that RLS allows, or to an RPC.
import type {
  AddressInput,
  AddressType,
  Appointment,
  AppointmentSlot,
  AppointmentStatus,
  AppointmentStatusHistory,
  AppointmentUpdate,
  AppointmentWithRefs,
  AvailableSlot,
  BookingChannel,
  ClaimInsert,
  ClaimUpdate,
  Clinician,
  ClinicianAffiliation,
  ClinicianInput,
  ClinicianQualification,
  ClinicianRating,
  ClinicianRatingSummary,
  ClinicianRegistration,
  ClinicianSchedule,
  ClinicianType,
  ConsentMethod,
  ConsultTranscript,
  Facility,
  FacilityBillingPolicy,
  InsuranceClaim,
  InsurancePlan,
  InsuranceProvider,
  IsoDate,
  IsoTimestamp,
  ModerationStatus,
  MyClinicianRating,
  Patient,
  PatientAddress,
  PatientInsert,
  PatientInsurancePolicy,
  PatientResidency,
  PatientUpdate,
  PolicyInput,
  RatingInput,
  RecordingConsent,
  RecordingSession,
  RegistrationStatus,
  ResidencyInput,
  ResidencyStatus,
  ScheduleException,
  ScheduleExceptionInput,
  Uuid,
  VisitVitals,
  VisitVitalsLatest,
  VitalsInput,
  AgentActivityRow,
  ClinicalFact,
  ClinicalField,
  ConsultKeyPoint,
  ConsultNoteRun,
  DecisionQuestion,
  EngineActivityRow,
  FactStatus,
  GpQuery,
  KeyPointStatus,
  ModelRegistryRow,
  OpenItem,
  TranscriptSegmentRow,
} from "@/types/db";

export type AppRole = "staff" | "admin" | null;

export interface Me {
  userId: Uuid;
  email: string | null;
  appRole: AppRole; // app_metadata.role
  signupRole: string | null; // user_metadata.signup_role, set by patient sign-up
  patient: Patient | null;
  clinician: Clinician | null;
}

export interface AppointmentFilter {
  patientId?: Uuid;
  clinicianId?: Uuid;
  facilityId?: Uuid;
  from?: IsoTimestamp; // scheduled_start >= from
  to?: IsoTimestamp; // scheduled_start < to
  statuses?: AppointmentStatus[];
  limit?: number;
  ascending?: boolean;
}

export interface SlotFilter {
  clinicianId?: Uuid;
  facilityId?: Uuid;
  from: IsoTimestamp;
  to: IsoTimestamp;
}

export interface BookInput {
  slotId: Uuid;
  reason?: string | null;
  visitType?: string | null;
  channel?: BookingChannel;
  patientId?: Uuid | null; // staff only
}

export interface ScheduleInput {
  clinician_id: Uuid;
  facility_id: Uuid;
  weekday: number;
  start_time: string;
  end_time: string;
  slot_minutes: number;
  valid_from: IsoDate;
  valid_to?: IsoDate | null;
}

export interface QualificationInput {
  qualification: string;
  institution: string | null;
  year_awarded: number | null;
}

export interface RegistrationInput {
  status: RegistrationStatus;
  conditions: string | null;
  valid_from: IsoDate;
}

export interface AffiliationInput {
  clinician_id: Uuid;
  facility_id: Uuid;
  role: string | null;
  medicare_provider_number: string | null;
  valid_from: IsoDate;
  valid_to?: IsoDate | null;
}

export interface RatingWithRefs extends ClinicianRating {
  appointment: Pick<Appointment, "id" | "scheduled_start" | "facility_id"> | null;
}

// transcribe-consult Edge Function responses (see its header comment).
export interface TranscribeStartResult {
  session_id: Uuid;
}
export interface TranscribeChunkResult {
  status: "stored" | "discarded";
  seq?: number;
  reason?: string;
}
export interface TranscribeFinishResult {
  transcript_id?: Uuid;
  status: "pending_patient_review" | "discarded";
  reason?: string;
}

export interface DataApi {
  // identity
  whoami(): Promise<Me | null>;

  // reference / directory (any signed-in user)
  listResidencyStatuses(): Promise<ResidencyStatus[]>;
  listInsuranceProviders(): Promise<InsuranceProvider[]>;
  listInsurancePlans(): Promise<InsurancePlan[]>;
  listFacilities(): Promise<Facility[]>;
  listBillingPolicies(): Promise<FacilityBillingPolicy[]>;
  listClinicians(): Promise<Clinician[]>;
  listQualifications(clinicianId?: Uuid): Promise<ClinicianQualification[]>;
  listRegistrations(clinicianId?: Uuid): Promise<ClinicianRegistration[]>;
  listAffiliations(clinicianId?: Uuid): Promise<ClinicianAffiliation[]>;
  listSchedules(filter?: { clinicianId?: Uuid; facilityId?: Uuid }): Promise<ClinicianSchedule[]>;

  // patients
  getPatient(id: Uuid): Promise<Patient | null>;
  createPatient(input: PatientInsert): Promise<Patient>;
  updatePatient(id: Uuid, patch: PatientUpdate): Promise<Patient>;
  searchPatients(query: string): Promise<Patient[]>;
  listAddresses(patientId: Uuid): Promise<PatientAddress[]>;
  changeAddress(patientId: Uuid, input: AddressInput): Promise<PatientAddress>;
  endAddress(patientId: Uuid, addressType: AddressType): Promise<void>;
  listResidency(patientId: Uuid): Promise<PatientResidency[]>;
  changeResidency(patientId: Uuid, input: ResidencyInput): Promise<PatientResidency>;
  listPolicies(patientId: Uuid): Promise<PatientInsurancePolicy[]>;
  changePolicy(patientId: Uuid, input: PolicyInput | null): Promise<PatientInsurancePolicy | null>;

  // booking RPCs
  getAvailableSlots(args: {
    date: IsoDate;
    facilityId?: Uuid | null;
    clinicianId?: Uuid | null;
    clinicianType?: ClinicianType | null;
  }): Promise<AvailableSlot[]>;
  holdSlot(slotId: Uuid): Promise<IsoTimestamp>;
  bookSlot(input: BookInput): Promise<Uuid>;
  cancelAppointment(id: Uuid, reason?: string | null): Promise<void>;
  rescheduleAppointment(id: Uuid, newSlotId: Uuid): Promise<Uuid>;
  // booking proposals from the booking agent: only the owning patient confirms or declines
  confirmBookingProposal(id: Uuid): Promise<Uuid>;
  declineBookingProposal(id: Uuid): Promise<void>;

  // slots (table)
  getSlot(id: Uuid): Promise<AppointmentSlot | null>;
  listSlots(filter: SlotFilter): Promise<AppointmentSlot[]>;
  setSlotBlocked(id: Uuid, blocked: boolean): Promise<AppointmentSlot>;

  // appointments
  listAppointments(filter?: AppointmentFilter): Promise<AppointmentWithRefs[]>;
  getAppointment(id: Uuid): Promise<AppointmentWithRefs | null>;
  updateAppointment(id: Uuid, patch: AppointmentUpdate): Promise<Appointment>;
  listStatusHistory(appointmentId: Uuid): Promise<AppointmentStatusHistory[]>;

  // recording consent, sessions, transcription (Edge Function)
  listConsents(appointmentId: Uuid): Promise<RecordingConsent[]>;
  giveConsent(appointmentId: Uuid, version: string, method?: ConsentMethod): Promise<Uuid>;
  withdrawConsent(appointmentId: Uuid, reason?: string | null): Promise<void>;
  listRecordingSessions(appointmentIds?: Uuid[]): Promise<RecordingSession[]>;
  transcribeStart(appointmentId: Uuid): Promise<TranscribeStartResult>;
  transcribeChunk(
    sessionId: Uuid,
    seq: number,
    audio: Blob,
    durationSeconds: number | null,
  ): Promise<TranscribeChunkResult>;
  transcribeFinish(sessionId: Uuid): Promise<TranscribeFinishResult>;
  transcribeCancel(sessionId: Uuid): Promise<void>;

  // transcripts
  listTranscripts(appointmentIds?: Uuid[]): Promise<ConsultTranscript[]>;
  getTranscript(id: Uuid): Promise<ConsultTranscript | null>;
  approveTranscript(id: Uuid): Promise<void>;
  rejectTranscript(id: Uuid): Promise<void>;

  // ratings
  getRatingSummary(clinicianId?: Uuid | null): Promise<ClinicianRatingSummary[]>;
  getMyRatingsAsClinician(): Promise<MyClinicianRating[]>;
  canRateAppointment(appointmentId: Uuid): Promise<boolean>;
  getRatingForAppointment(appointmentId: Uuid): Promise<ClinicianRating | null>;
  createRating(appointmentId: Uuid, input: RatingInput): Promise<ClinicianRating>;
  updateRating(id: Uuid, input: RatingInput): Promise<ClinicianRating>;
  listRatings(filter?: { clinicianIds?: Uuid[]; status?: ModerationStatus }): Promise<RatingWithRefs[]>;
  moderateRating(id: Uuid, status: ModerationStatus): Promise<void>;

  // vitals
  listVitals(appointmentId: Uuid): Promise<VisitVitals[]>;
  listVitalsLatest(patientId: Uuid): Promise<VisitVitalsLatest[]>;
  addVitals(appointmentId: Uuid, input: VitalsInput): Promise<VisitVitals>;

  // schedules and exceptions
  listExceptions(filter?: { clinicianId?: Uuid; from?: IsoTimestamp }): Promise<ScheduleException[]>;
  addException(input: ScheduleExceptionInput): Promise<ScheduleException>;
  deleteException(id: Uuid): Promise<void>;
  addSchedule(input: ScheduleInput): Promise<ClinicianSchedule>;
  endSchedule(id: Uuid, validTo: IsoDate): Promise<void>;

  // clinician administration (staff)
  createClinician(input: ClinicianInput): Promise<Clinician>;
  updateClinician(id: Uuid, input: Partial<ClinicianInput>): Promise<Clinician>;
  addQualification(clinicianId: Uuid, input: QualificationInput): Promise<ClinicianQualification>;
  updateQualification(id: Uuid, input: QualificationInput): Promise<ClinicianQualification>;
  addRegistration(clinicianId: Uuid, input: RegistrationInput): Promise<ClinicianRegistration>;
  addAffiliation(input: AffiliationInput): Promise<ClinicianAffiliation>;
  endAffiliation(id: Uuid, validTo: IsoDate): Promise<void>;

  // claims
  listClaims(appointmentIds?: Uuid[]): Promise<InsuranceClaim[]>;
  createClaim(input: ClaimInsert): Promise<InsuranceClaim>;
  updateClaim(id: Uuid, patch: ClaimUpdate): Promise<InsuranceClaim>;

  // Part B: patient self check-in (patient_check_in RPC)
  patientCheckIn(appointmentId: Uuid): Promise<void>;

  // agent layer: reference data
  listDecisionQuestions(): Promise<DecisionQuestion[]>;
  listClinicalFields(): Promise<ClinicalField[]>;

  // agent layer: drafts for human review (RLS: treating clinician or staff;
  // the patient sees approved facts / key points of their own visits)
  listKeyPoints(filter?: AgentRowFilter<KeyPointStatus>): Promise<ConsultKeyPoint[]>;
  listClinicalFacts(filter?: AgentRowFilter<FactStatus> & { patientId?: Uuid }): Promise<ClinicalFact[]>;
  listOpenItems(filter?: AgentRowFilter<"open" | "resolved">): Promise<OpenItem[]>;
  listGpQueries(filter?: AgentRowFilter<"open" | "answered">): Promise<GpQuery[]>;
  listTranscriptSegments(appointmentId: Uuid): Promise<TranscriptSegmentRow[]>;
  listConsultNoteRuns(appointmentIds?: Uuid[]): Promise<ConsultNoteRun[]>;

  // agent layer: human-only review functions
  approveKeyPoint(id: Uuid): Promise<void>;
  editAndApproveKeyPoint(id: Uuid, answer: string): Promise<void>;
  editAndApproveKeyPointText(id: Uuid, text: string): Promise<void>;
  rejectKeyPoint(id: Uuid): Promise<void>;
  approveFact(id: Uuid): Promise<void>;
  editAndApproveFact(id: Uuid, value: unknown): Promise<void>;
  rejectFact(id: Uuid): Promise<void>;
  resolveOpenItem(id: Uuid, resolution: string): Promise<void>;
  answerGpQuery(id: Uuid, answer: string): Promise<void>;

  // operations (staff): counts and latency only, never patient data
  getAgentActivity(hours?: number): Promise<AgentActivityRow[]>;
  getEngineActivity(hours?: number): Promise<EngineActivityRow[]>;
  listModelRegistry(): Promise<ModelRegistryRow[]>;
}

export interface AgentRowFilter<S extends string> {
  appointmentIds?: Uuid[];
  statuses?: S[];
}

// Realtime is separate from the request/response API: only appointment_slots
// is published today. Returns an unsubscribe function.
export interface SlotChange {
  slot: Pick<AppointmentSlot, "id" | "status" | "held_by_patient_id" | "held_until" | "clinician_id">;
}
export type SubscribeSlots = (clinicianId: Uuid, onChange: (change: SlotChange) => void) => () => void;

export const DATA_API_METHODS = [
  "whoami",
  "listResidencyStatuses",
  "listInsuranceProviders",
  "listInsurancePlans",
  "listFacilities",
  "listBillingPolicies",
  "listClinicians",
  "listQualifications",
  "listRegistrations",
  "listAffiliations",
  "listSchedules",
  "getPatient",
  "createPatient",
  "updatePatient",
  "searchPatients",
  "listAddresses",
  "changeAddress",
  "endAddress",
  "listResidency",
  "changeResidency",
  "listPolicies",
  "changePolicy",
  "getAvailableSlots",
  "holdSlot",
  "bookSlot",
  "cancelAppointment",
  "rescheduleAppointment",
  "confirmBookingProposal",
  "declineBookingProposal",
  "getSlot",
  "listSlots",
  "setSlotBlocked",
  "listAppointments",
  "getAppointment",
  "updateAppointment",
  "listStatusHistory",
  "listConsents",
  "giveConsent",
  "withdrawConsent",
  "listRecordingSessions",
  "transcribeStart",
  "transcribeChunk",
  "transcribeFinish",
  "transcribeCancel",
  "listTranscripts",
  "getTranscript",
  "approveTranscript",
  "rejectTranscript",
  "getRatingSummary",
  "getMyRatingsAsClinician",
  "canRateAppointment",
  "getRatingForAppointment",
  "createRating",
  "updateRating",
  "listRatings",
  "moderateRating",
  "listVitals",
  "listVitalsLatest",
  "addVitals",
  "listExceptions",
  "addException",
  "deleteException",
  "addSchedule",
  "endSchedule",
  "createClinician",
  "updateClinician",
  "addQualification",
  "updateQualification",
  "addRegistration",
  "addAffiliation",
  "endAffiliation",
  "listClaims",
  "createClaim",
  "updateClaim",
  "patientCheckIn",
  "listDecisionQuestions",
  "listClinicalFields",
  "listKeyPoints",
  "listClinicalFacts",
  "listOpenItems",
  "listGpQueries",
  "listTranscriptSegments",
  "listConsultNoteRuns",
  "approveKeyPoint",
  "editAndApproveKeyPoint",
  "editAndApproveKeyPointText",
  "rejectKeyPoint",
  "approveFact",
  "editAndApproveFact",
  "rejectFact",
  "resolveOpenItem",
  "answerGpQuery",
  "getAgentActivity",
  "getEngineActivity",
  "listModelRegistry",
] as const satisfies readonly (keyof DataApi)[];

// Compile-time check that the list above names every method.
type Missing = Exclude<keyof DataApi, (typeof DATA_API_METHODS)[number]>;
const _allMethodsListed: Missing extends never ? true : Missing = true;
void _allMethodsListed;

// An error carrying the Postgres/PostgREST code and message, so screens can map
// it to a friendly sentence (src/lib/errors.ts).
export class DataError extends Error {
  constructor(
    message: string,
    public readonly code: string | null = null,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = "DataError";
  }
}
