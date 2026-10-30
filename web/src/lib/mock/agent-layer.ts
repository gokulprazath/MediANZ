// Mock agent layer: reference data from supabase/seed/04_agent_layer_sample.sql,
// sample drafts awaiting review, and a stand-in for the consult-notes worker
// (src/healthmcp/consult_notes) so the clinician review queue fills after a
// patient approves a transcript. Deterministic keyword rules, not a model.
import type {
  ClinicalFact,
  ClinicalField,
  ConsultKeyPoint,
  ConsultNoteRun,
  ConsultTranscript,
  DecisionQuestion,
  GpQuery,
  ModelRegistryRow,
  OpenItem,
  TranscriptSegmentRow,
  Uuid,
} from "@/types/db";
import type { ResearchDraftSummary } from "@/lib/agents/types";

export interface AgentLogRow {
  agent_id: string;
  server: string;
  tool: string;
  ok: boolean;
  latency_ms: number;
  created_at: string;
}
export interface DecisionLogRow {
  engine: string;
  model: string | null;
  latency_ms: number;
  created_at: string;
}

export interface AgentLayerState {
  decision_questions: DecisionQuestion[];
  clinical_fields: ClinicalField[];
  clinical_facts: ClinicalFact[];
  consult_key_points: ConsultKeyPoint[];
  open_items: OpenItem[];
  gp_queries: GpQuery[];
  transcript_segments: TranscriptSegmentRow[];
  consult_note_runs: ConsultNoteRun[];
  model_registry: ModelRegistryRow[];
  agent_access_log: AgentLogRow[];
  decision_log: DecisionLogRow[];
  research_drafts: ResearchDraftSummary[];
  discovery_bookings: Record<string, Uuid>; // idempotency key -> appointment id
  booking_proposals: MockBookingProposal[];
}

// public.booking_proposals (kind 'book' only: the assistant proposes new bookings).
export interface MockBookingProposal {
  id: Uuid;
  patient_id: Uuid;
  slot_id: Uuid;
  reason: string | null;
  status: "pending" | "confirmed" | "declined" | "expired";
  expires_at: string;
  created_by_agent: string;
  result_appointment_id: Uuid | null;
}

const YES_NO = [{ value: "yes" }, { value: "no" }, { value: "not_stated" }];
const q = (id: string, kind: DecisionQuestion["kind"], text: string, options: DecisionQuestion["options"], threshold: number) => ({
  id,
  version: 1,
  kind,
  text,
  options,
  threshold,
  threshold_model_version: "1",
  active: true,
  created_at: "2026-10-27T00:00:00Z",
});

export const SEED_QUESTIONS: DecisionQuestion[] = [
  q("chest_pain_reported", "yes_no", "Does the patient report chest pain or chest tightness?", YES_NO, 0.8),
  q("shortness_of_breath_reported", "yes_no", "Does the patient report shortness of breath?", YES_NO, 0.8),
  q("fatigue_reported", "yes_no", "Does the patient report tiredness or fatigue?", YES_NO, 0.7),
  q("medication_started", "yes_no", "Did the clinician start or prescribe a new medication or supplement?", YES_NO, 0.75),
  q("follow_up_arranged", "yes_no", "Was a follow-up visit or repeat test arranged?", YES_NO, 0.7),
  q(
    "smoker_status",
    "choice",
    "What is the patient's smoking status?",
    [
      { value: "current", label: "Currently smokes" },
      { value: "former", label: "Used to smoke, has quit" },
      { value: "never", label: "Has never smoked" },
      { value: "unclear", label: "Not stated or unclear" },
    ],
    0.7,
  ),
  q(
    "urgency_level",
    "score",
    "How urgently does something discussed need clinical attention?",
    [
      { value: "routine", level: 0, description: "Routine: can wait for the next planned visit" },
      { value: "soon", level: 1, description: "Soon: should be reviewed within a few days" },
      { value: "urgent", level: 2, description: "Urgent: needs review today" },
      { value: "emergency", level: 3, description: "Emergency: needs immediate care (call 000)" },
    ],
    0.8,
  ),
];

const f = (id: string, label: string, topic: string, unit: string | null, schema: Record<string, unknown>): ClinicalField => ({
  id,
  version: 1,
  label,
  value_schema: schema,
  unit,
  code_system: null,
  topic,
  active: true,
  created_at: "2026-10-27T00:00:00Z",
});
const obj = (props: string[], required: string[]) => ({
  type: "object",
  properties: Object.fromEntries(props.map((p) => [p, { type: "string" }])),
  required,
  additionalProperties: false,
});

export const SEED_FIELDS: ClinicalField[] = [
  f("bp_reading", "Blood pressure", "observation", "mm[Hg]", {
    type: "object",
    properties: { systolic: { type: "integer" }, diastolic: { type: "integer" } },
    required: ["systolic", "diastolic"],
  }),
  f("body_temperature", "Body temperature", "observation", "Cel", { type: "number", minimum: 30, maximum: 45 }),
  f("body_weight", "Body weight", "observation", "kg", { type: "number", minimum: 0.5, maximum: 400 }),
  f("current_medication", "Current medication", "medication", null, obj(["name", "dose", "frequency"], ["name"])),
  f("allergy", "Allergy", "allergy", null, obj(["substance", "reaction"], ["substance"])),
  f("smoking_status", "Smoking status", "social_history", null, { type: "string", enum: ["current", "former", "never"] }),
  f("symptom", "Symptom", "symptom", null, obj(["name", "duration"], ["name"])),
  f("follow_up", "Follow-up plan", "plan", null, obj(["action", "interval"], ["action"])),
];

const engine = (e: string, capability: ModelRegistryRow["capability"], provider: string, model: string, health: boolean): ModelRegistryRow => ({
  engine: e,
  capability,
  provider,
  model,
  model_version: "mock",
  region: null,
  zero_data_retention: true,
  allow_health_data: health,
  enabled: true,
  created_at: "2026-10-27T00:00:00Z",
  updated_at: "2026-10-27T00:00:00Z",
});

export function emptyAgentLayer(): AgentLayerState {
  return {
    decision_questions: SEED_QUESTIONS.map((x) => ({ ...x })),
    clinical_fields: SEED_FIELDS.map((x) => ({ ...x })),
    clinical_facts: [],
    consult_key_points: [],
    open_items: [],
    gp_queries: [],
    transcript_segments: [],
    consult_note_runs: [],
    model_registry: [
      engine("mock_decision", "decision", "MediANZ mock", "mock-decision", true),
      engine("mock_extraction", "extraction", "MediANZ mock", "mock-extraction", true),
      engine("mock_search", "search", "MediANZ mock", "mock-search", false),
      engine("mock_places", "places", "MediANZ mock", "mock-places", false),
    ],
    agent_access_log: [],
    decision_log: [],
    research_drafts: [],
    discovery_bookings: {},
    booking_proposals: [],
  };
}

let idCounter = 0;
const uuid = (prefix: string) => `${prefix}-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`;

/** transcript_segments for a transcript, like public.build_transcript_segments. */
export function buildSegments(layer: AgentLayerState, t: ConsultTranscript, at: string): TranscriptSegmentRow[] {
  const existing = layer.transcript_segments.filter((s) => s.transcript_id === t.id);
  if (existing.length) return existing;
  const parts = t.segments?.length
    ? t.segments.map((s) => ({ speaker: s.speaker, start: s.start_sec, end: s.end_sec, text: s.text }))
    : [{ speaker: null as string | null, start: null as number | null, end: null as number | null, text: t.transcript_text }];
  let offset = 0;
  const rows = parts.map((p, i) => {
    const start = t.transcript_text.indexOf(p.text, offset);
    const row: TranscriptSegmentRow = {
      id: uuid("74000000"),
      transcript_id: t.id,
      appointment_id: t.appointment_id,
      seq: i + 1,
      speaker: p.speaker,
      speaker_confidence: null,
      start_sec: p.start,
      end_sec: p.end,
      text: p.text,
      char_start: start >= 0 ? start : null,
      char_end: start >= 0 ? start + p.text.length : null,
      created_at: at,
    };
    if (start >= 0) offset = start + p.text.length;
    return row;
  });
  layer.transcript_segments.push(...rows);
  return rows;
}

const has = (text: string, re: RegExp) => re.test(text.toLowerCase());

/**
 * Stand-in for the consult-notes worker: approved transcript -> draft key
 * points, draft facts and open items for the clinician to review.
 */
export function runMockConsultWorker(
  layer: AgentLayerState,
  t: ConsultTranscript,
  patientId: Uuid,
  at: string,
): ConsultNoteRun {
  const segs = buildSegments(layer, t, at);
  const text = t.transcript_text;
  const segFor = (re: RegExp) => {
    const s = segs.find((x) => re.test(x.text.toLowerCase()));
    return s ? [s.id] : [segs[0].id];
  };
  const base = {
    transcript_id: t.id,
    appointment_id: t.appointment_id,
    patient_id: patientId,
    question_version: 1,
    answer_source: "decision_engine" as const,
    answer_text: null,
    level: null,
    other_opinion_answer: null,
    other_opinion_probability: null,
    other_opinion_engine: null,
    status: "draft" as const,
    answer_edited: false,
    engine: "mock_decision",
    model_version: "mock",
    created_by_agent: "clinical-doc-agent",
    reviewed_by: null,
    reviewed_at: null,
    created_at: at,
    updated_at: at,
  };
  const yesNo = (questionId: string, re: RegExp, threshold: number) => {
    const yes = has(text, re);
    const probability = yes ? 0.91 : 0.66;
    return {
      ...base,
      id: uuid("75000000"),
      question_id: questionId,
      kind: "yes_no" as const,
      answer: yes ? "yes" : "not_stated",
      answer_label: yes ? "Yes" : "Not stated",
      probability,
      threshold,
      meets_threshold: probability >= threshold,
      source_segment_ids: segFor(re),
    };
  };
  const keyPoints: ConsultKeyPoint[] = [
    yesNo("fatigue_reported", /tired|fatigue|exhaust/, 0.7),
    yesNo("medication_started", /supplement|prescri|medication|tablet|start(ed)? (you|an?)/, 0.75),
    yesNo("follow_up_arranged", /repeat|come back|follow[- ]?up|review in|check again/, 0.7),
    yesNo("chest_pain_reported", /chest pain|chest tight/, 0.8),
  ];
  const urgent = has(text, /chest pain|can't breathe|cannot breathe/);
  keyPoints.push({
    ...base,
    id: uuid("75000000"),
    question_id: "urgency_level",
    kind: "score",
    answer: urgent ? "urgent" : "routine",
    answer_label: urgent ? "Urgent: needs review today" : "Routine: can wait for the next planned visit",
    level: urgent ? 2 : 0,
    probability: 0.84,
    threshold: 0.8,
    meets_threshold: true,
    other_opinion_answer: urgent ? "soon" : null,
    other_opinion_probability: urgent ? 0.41 : null,
    other_opinion_engine: urgent ? "slm" : null,
    source_segment_ids: segFor(/chest|breath|pain/),
  });

  const fact = (field_id: string, value: unknown, re: RegExp, confidence: number): ClinicalFact => ({
    id: uuid("76000000"),
    appointment_id: t.appointment_id,
    patient_id: patientId,
    field_id,
    field_version: 1,
    value,
    unit: null,
    code_system: null,
    code: null,
    status: "draft",
    negated: false,
    experiencer: "patient",
    temporality: "current",
    source: "transcript",
    source_segment_ids: segFor(re),
    confidence,
    engine: "mock_extraction",
    model_version: "mock",
    value_edited: false,
    created_by_agent: "clinical-doc-agent",
    approved_by: null,
    approved_at: null,
    valid_from: at.slice(0, 10),
    valid_to: null,
    created_at: at,
    updated_at: at,
  });
  const facts: ClinicalFact[] = [];
  if (has(text, /iron/)) facts.push(fact("current_medication", { name: "Iron supplement", frequency: "Once a day" }, /supplement|tablet/, 0.88));
  if (has(text, /tired|fatigue/)) facts.push(fact("symptom", { name: "Tiredness" }, /tired|fatigue/, 0.79));
  if (has(text, /repeat the blood test|repeat blood test/)) {
    facts.push(fact("follow_up", { action: "Repeat blood test", interval: "3 months" }, /repeat/, 0.86));
  }
  if (has(text, /ankle/)) facts.push(fact("symptom", { name: "Ankle sprain", duration: "Since Saturday" }, /ankle/, 0.81));

  const openItems: OpenItem[] = [];
  const med = facts.find((x) => x.field_id === "current_medication");
  if (med) {
    openItems.push({
      id: uuid("77000000"),
      appointment_id: t.appointment_id,
      kind: "missing_info",
      severity: null,
      description: "The supplement's dose was not stated in the consultation.",
      related_fact_ids: [med.id],
      status: "open",
      resolution: null,
      resolved_by: null,
      resolved_at: null,
      created_by_agent: "clinical-doc-agent",
      created_at: at,
      updated_at: at,
    });
  }
  if (urgent) {
    openItems.push({
      id: uuid("77000000"),
      appointment_id: t.appointment_id,
      kind: "urgent",
      severity: 8,
      description: "Chest symptoms were mentioned. Please review today.",
      related_fact_ids: [],
      status: "open",
      resolution: null,
      resolved_by: null,
      resolved_at: null,
      created_by_agent: "clinical-doc-agent",
      created_at: at,
      updated_at: at,
    });
  }

  layer.consult_key_points.push(...keyPoints);
  layer.clinical_facts.push(...facts);
  layer.open_items.push(...openItems);
  for (const tool of ["get_transcript_windows", "decide_yes_no", "decide_score", "extract_value", "save_draft_fact", "check_grounding"]) {
    layer.agent_access_log.push({ agent_id: "clinical-doc-agent", server: tool.startsWith("decide") ? "decision" : tool === "get_transcript_windows" || tool === "check_grounding" ? "transcript" : "extraction", tool, ok: true, latency_ms: 120 + tool.length * 9, created_at: at });
  }
  for (let i = 0; i < keyPoints.length; i++) layer.decision_log.push({ engine: "mock_decision", model: "mock-decision", latency_ms: 80 + i * 7, created_at: at });
  layer.decision_log.push({ engine: "mock_extraction", model: "mock-extraction", latency_ms: 240, created_at: at });

  const run: ConsultNoteRun = {
    id: uuid("78000000"),
    transcript_id: t.id,
    appointment_id: t.appointment_id,
    status: "done",
    attempts: 1,
    last_error: null,
    facts_count: facts.length,
    key_points_count: keyPoints.length,
    open_items_count: openItems.length,
    queued_at: at,
    started_at: at,
    finished_at: at,
    created_at: at,
    updated_at: at,
  };
  layer.consult_note_runs.push(run);
  return run;
}

/** Sample research drafts for the staff operations page (web-research agent output). */
export function seedResearchDrafts(layer: AgentLayerState, at: string, ids: { plan: Uuid; facility: Uuid; provider: Uuid }) {
  layer.research_drafts.push(
    {
      id: "79000000-0000-4000-8000-000000000001",
      kind: "coverage",
      status: "pending",
      plan_id: ids.plan,
      facility_id: null,
      insurer_provider_id: ids.provider,
      service_id: "70000000-0000-4000-8000-000000000007",
      insurance_category: "specialist",
      coverage_status: "not_covered",
      accepted: null,
      claim_mode: null,
      source_type: "insurer_site",
      source_url: "https://example.com/insurer/extras-cover",
      evidence_quote: "Out-of-hospital specialist consultations are not covered under extras.",
      confidence: 0.82,
      created_at: at,
    },
    {
      id: "79000000-0000-4000-8000-000000000002",
      kind: "acceptance",
      status: "pending",
      plan_id: null,
      facility_id: ids.facility,
      insurer_provider_id: ids.provider,
      service_id: null,
      insurance_category: "gp",
      coverage_status: null,
      accepted: true,
      claim_mode: "manual",
      source_type: "clinic_site",
      source_url: "https://example.com/clinic/fees",
      evidence_quote: "We accept all major health funds; claims are lodged by the patient after the visit.",
      confidence: 0.74,
      created_at: at,
    },
  );
}
