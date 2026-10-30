import "server-only";
// Mock mode only: offline stand-ins for the Python agent service (/chat,
// /chat/confirm) and discovery API (/v1/...), over the in-memory mock
// database. Deterministic rules with the same request/response shapes and
// error codes, so the screens and e2e tests run without the services. Live
// mode never uses this file.
import type {
  AgentRole,
  ChatResponse,
  ClinicCard,
  CoverageStatus,
  DiscoveryResponse,
  InsuranceResult,
  ProviderOption,
  ResearchDraftSummary,
  Service,
} from "@/lib/agents/types";
import { DataError } from "@/lib/data/api";
import { haversineKm } from "@/lib/geo";
import { clinicianName, formatMoney } from "@/lib/format";
import { formatDate, formatDateTime, localDate } from "@/lib/time";
import type { Uuid } from "@/types/db";
import type { MockState } from "./seed";
import { policyOn, validOn } from "./seed";
import { createMockApi } from "./store";

export interface MockAgentResult {
  status: number;
  body: unknown;
}

const VERIFY_WARNING =
  "Coverage is based on public information and is not guaranteed. Confirm the benefit and claim method with your insurer and clinic.";

// Mirrors supabase/seed/05_discovery_sample.sql (service_catalog).
export const MOCK_SERVICES: Service[] = [
  { id: "70000000-0000-4000-8000-000000000001", code: "gp_standard", name: "Standard GP consultation", category: "gp", insurance_category: "gp", required_specialty: "General Practice", default_duration_minutes: 15 },
  { id: "70000000-0000-4000-8000-000000000002", code: "gp_long", name: "Long GP consultation", category: "gp", insurance_category: "gp", required_specialty: "General Practice", default_duration_minutes: 30 },
  { id: "70000000-0000-4000-8000-000000000003", code: "dental_check", name: "Dental check-up and clean", category: "dental", insurance_category: "general_dental", required_specialty: "Dentistry", default_duration_minutes: 30 },
  { id: "70000000-0000-4000-8000-000000000006", code: "vaccination", name: "Vaccination", category: "preventive", insurance_category: "gp", required_specialty: null, default_duration_minutes: 15 },
  { id: "70000000-0000-4000-8000-000000000007", code: "skin_check", name: "Skin check", category: "specialist", insurance_category: "specialist", required_specialty: "Dermatology", default_duration_minutes: 30 },
];

// service_prices from seed 05 (fee, Medicare rebate) by facility number.
const PRICES: Record<string, Record<string, [number, number]>> = {
  gp_standard: { "1": [85, 43.9], "2": [85, 43.9], "4": [75, 43.9] },
  gp_long: { "1": [140, 76.5] },
  vaccination: { "1": [0, 0] },
  skin_check: { "3": [250, 0] },
};

const SERVICE_WORDS: [RegExp, string][] = [
  [/\b(skin|mole|moles|rash|spot|freckle|derm)/, "skin_check"],
  [/\b(vaccin|flu shot|flu jab|booster|immunis|jab)/, "vaccination"],
  [/\b(tooth|teeth|dental|dentist|gum)/, "dental_check"],
  [/\b(long (appointment|consult)|several (things|issues)|mental health plan|care plan)/, "gp_long"],
  [/\b(gp|doctor|check[- ]?up|blood test|results?|prescription|script|cough|cold|fever|sore|pain|ache|tired|sick|infection|ear|throat|back|headache|referral|blood pressure)/, "gp_standard"],
];

export function resolveService(code: string | null | undefined, problem: string | null | undefined): Service | null {
  if (code) return MOCK_SERVICES.find((s) => s.code === code) ?? null;
  const text = ` ${(problem ?? "").toLowerCase()} `;
  for (const [re, c] of SERVICE_WORDS) if (re.test(text)) return MOCK_SERVICES.find((s) => s.code === c) ?? null;
  return null;
}

// agent.py route_question: the router, not the model, picks the agent.
const INSURANCE = ["insurance", "cover", "coverage", "rebate", "extras", "oshc", "overseas", "policy", "health fund", "claim"];
const INSIGHTS = ["my result", "my health", "my record", "my observation", "approved fact", "blood", "cholesterol", "diagnosis", "medication", "symptom", "my gp", "my doctor", "question for", "supplement", "iron", "tablet", "allerg"];
const EXPLAINER = ["score", "why was", "why is", "explain the match", "explain this match", "explain the recommend", "fee", "fees", "cost", "price", "expensive", "cheaper", "breakdown"];

export function routeQuestion(message: string): AgentRole {
  const text = message.toLowerCase().split(/\s+/).join(" ");
  if (INSURANCE.some((m) => text.includes(m))) return "insurance";
  if (INSIGHTS.some((m) => text.includes(m))) return "insights";
  if (EXPLAINER.some((m) => text.includes(m))) return "explainer";
  return "insights";
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number | null) => (n === null ? null : n.toFixed(2));
const err = (status: number, error: string, extra: Record<string, unknown> = {}): MockAgentResult => ({
  status,
  body: { error, message: error, ...extra },
});

// Same shape as agent.py's signed action (base64url JSON + "." + signature),
// with a fixed marker instead of an HMAC: mock mode has no secret.
const MOCK_SIGNATURE = "mock-unsigned";
function encodeAction(payload: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + 900 }), "utf8").toString("base64url");
  return `${body}.${MOCK_SIGNATURE}`;
}
function decodeAction(token: string): Record<string, unknown> | null {
  const [body, signature] = token.split(".");
  if (!body || signature !== MOCK_SIGNATURE) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof payload.exp === "number" && payload.exp * 1000 > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

export async function handleMockAgentRequest(
  state: MockState,
  uid: string,
  path: string,
  method: "GET" | "POST",
  body: unknown,
  query: URLSearchParams,
): Promise<MockAgentResult> {
  const api = createMockApi(state, uid);
  const me = await api.whoami();
  if (!me) return err(401, "unauthorized");
  const now = new Date();
  const log = (agent_id: string, server: string, tool: string, ok = true, latency_ms = 90) =>
    state.agent.agent_access_log.push({ agent_id, server, tool, ok, latency_ms, created_at: now.toISOString() });
  const b = (body ?? {}) as Record<string, unknown>;
  const isStaff = me.appRole === "staff" || me.appRole === "admin";
  const patient = me.patient;

  try {
    // ---------------------------------------------------------------- agent
    if (path === "/chat") {
      const message = typeof b.message === "string" ? b.message.trim() : "";
      if (!message || message.length > 8000) return err(422, "invalid_request");
      if (!patient) return err(401, "unauthorized");
      const agent = routeQuestion(message);
      return { status: 200, body: await chat(state, api, patient.id, agent, message, log) };
    }
    if (path === "/chat/confirm") {
      if (!patient) return err(401, "unauthorized");
      const payload = typeof b.action === "string" ? decodeAction(b.action) : null;
      if (!payload || payload.patient_id !== patient.id || typeof payload.question !== "string") return err(401, "unauthorized");
      const appointment = await api.getAppointment(String(payload.appointment_id));
      if (!appointment || appointment.patient_id !== patient.id) return err(401, "unauthorized");
      const at = now.toISOString();
      const id = crypto.randomUUID();
      state.agent.gp_queries.push({
        id,
        appointment_id: appointment.id,
        question: payload.question,
        context_fact_ids: (payload.context_fact_ids as string[]) ?? [],
        status: "open",
        answer: null,
        answered_by: null,
        answered_at: null,
        created_by_agent: "insights-writer",
        created_at: at,
        updated_at: at,
      });
      log("insights-writer", "extraction", "create_gp_query", true, 70);
      return { status: 200, body: { status: "created", result: { gp_query_id: id } } };
    }

    // ------------------------------------------------------------ discovery
    if (path === "/v1/services") return { status: 200, body: MOCK_SERVICES };

    if (path === "/v1/discovery") {
      const lat = Number(b.latitude);
      const lng = Number(b.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return err(422, "invalid_request");
      const service = resolveService(b.service_code as string | null, b.problem_text as string | null);
      if (!service) {
        if (b.service_code) return err(404, "SERVICE_NOT_FOUND");
        return err(422, "NEEDS_SERVICE_CLARIFICATION", {
          candidates: MOCK_SERVICES.filter((s) => s.category !== "dental").map((s) => ({ code: s.code, name: s.name, category: s.category })),
        });
      }
      const radius = Math.min(500, Math.max(1, Number(b.max_distance_km ?? 50)));
      const limit = Math.min(100, Math.max(1, Number(b.limit ?? 20)));
      log("patient-concierge", "matching", "find_gp_candidates", true, 280);
      log("patient-concierge", "matching", "get_fees", true, 85);
      return { status: 200, body: discover(state, patient?.id ?? null, service, lat, lng, radius, limit, now) };
    }

    if (path === "/v1/availability") {
      const date = query.get("date") ?? "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return err(422, "invalid_request");
      const slots = await api.getAvailableSlots({ date, facilityId: query.get("facility_id"), clinicianId: query.get("clinician_id") });
      return {
        status: 200,
        body: slots.map((s) => ({
          slot_id: s.slot_id,
          facility_id: s.facility_id,
          facility_name: s.facility_name,
          clinician_id: s.clinician_id,
          clinician_name: s.clinician_name,
          starts_at: s.starts_at,
          ends_at: s.ends_at,
          local_start: s.local_start,
          timezone: s.facility_tz,
        })),
      };
    }

    if (path === "/v1/holds") {
      const heldUntil = await api.holdSlot(String(b.slot_id));
      log("patient-concierge", "booking", "hold_slot", true, 60);
      return { status: 200, body: { slot_id: b.slot_id, held_until: heldUntil } };
    }

    if (path === "/v1/bookings") {
      if (!patient) return err(401, "unauthorized");
      const key = String(b.idempotency_key ?? "");
      if (key.length < 8) return err(422, "invalid_request");
      const service = resolveService(String(b.service_code ?? ""), null);
      if (!service) return err(404, "SERVICE_NOT_FOUND");
      const slot = state.appointment_slots.find((s) => s.id === b.slot_id);
      if (!slot) return err(409, "SLOT_TAKEN");
      const quote = quoteFor(state, patient.id, service, slot.facility_id, now);
      const existing = state.agent.discovery_bookings[`${patient.id}|${key}`];
      let appointmentId = existing;
      if (!existing) {
        if (b.expected_gap !== undefined && b.expected_gap !== null && money(quote.gap) !== String(b.expected_gap)) {
          return err(409, "QUOTE_CHANGED", { expected_gap: String(b.expected_gap), current_gap: money(quote.gap) });
        }
        appointmentId = await api.bookSlot({
          slotId: slot.id,
          reason: typeof b.reason === "string" ? b.reason.slice(0, 500) : null,
          visitType: service.code === "gp_long" ? "long" : service.code === "vaccination" ? "vaccination" : "standard",
          channel: "web",
        });
        state.agent.discovery_bookings[`${patient.id}|${key}`] = appointmentId;
        log("patient-concierge", "booking", "book_service_slot", true, 150);
      }
      const a = (await api.getAppointment(appointmentId!))!;
      return {
        status: 201,
        body: {
          appointment_id: a.id,
          status: a.status,
          scheduled_start: a.scheduled_start,
          facility_id: a.facility_id,
          clinician_id: a.clinician_id,
          service_code: service.code,
          quoted_fee: money(quote.fee),
          quoted_gap: money(quote.gap),
          coverage_status: quote.insurance.coverage_status,
          claim_mode: quote.insurance.claim_mode,
        },
      };
    }

    if (path === "/v1/research/drafts") {
      if (!isStaff) return err(403, "STAFF_REQUIRED");
      const status = query.get("status") ?? "pending";
      return {
        status: 200,
        body: state.agent.research_drafts.filter((d) => status === "all" || d.status === status),
      };
    }
    const research = /^\/v1\/research\/drafts\/([0-9a-f-]{36})\/(approve|reject)$/.exec(path);
    if (research) {
      if (!isStaff) return err(403, "STAFF_REQUIRED");
      const draft = state.agent.research_drafts.find((d) => d.id === research[1]);
      if (!draft) return err(404, "NOT_FOUND");
      if (draft.status !== "pending") return err(409, "NOT_PENDING");
      (draft as ResearchDraftSummary).status = research[2] === "approve" ? "approved" : "rejected";
      return research[2] === "approve"
        ? { status: 200, body: { draft_id: draft.id, rule_id: crypto.randomUUID() } }
        : { status: 204, body: null };
    }
    return err(404, "not_found");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/Slot is no longer available/i.test(message)) return err(409, "SLOT_TAKEN");
    if (e instanceof DataError && e.code === "42501") return err(403, "FORBIDDEN");
    return err(400, "invalid_request");
  }
}

// --------------------------------------------------------------------------
// Chat agents
// --------------------------------------------------------------------------
async function chat(
  state: MockState,
  api: ReturnType<typeof createMockApi>,
  patientId: Uuid,
  agent: AgentRole,
  message: string,
  log: (agent: string, server: string, tool: string, ok?: boolean, latency?: number) => void,
): Promise<ChatResponse> {
  const reply = (answer: string, pending: { appointment_id: Uuid; question: string } | null = null): ChatResponse => ({
    agent,
    answer,
    pending_action: pending ? encodeAction({ ...pending, sub: patientId, patient_id: patientId, context_fact_ids: [] }) : null,
    appointment_id: pending?.appointment_id ?? null,
  });

  if (agent === "insurance") {
    log("insurance", "matching", "get_plan_coverage", true, 120);
    const today = new Date().toISOString().slice(0, 10);
    const policy = policyOn(state, patientId, today);
    if (!policy) {
      return reply(
        "I can't find a private health policy on your profile today. GP visits are paid by Medicare (bulk billed, or a gap if the clinic charges more); private insurance doesn't cover them. You can add a policy in your profile.",
      );
    }
    const plan = state.insurance_plans.find((p) => p.id === policy.plan_id);
    const provider = state.insurance_providers.find((p) => p.id === plan?.provider_id);
    const extras = plan?.cover_type === "extras" || plan?.cover_type === "combined";
    return reply(
      [
        `Your plan is ${plan?.plan_name ?? "a private plan"} with ${provider?.name ?? "your insurer"} (${plan?.cover_type ?? "unknown"} cover), membership ${policy.membership_number}.`,
        "GP consultations aren't covered by private health insurance in Australia; Medicare pays the rebate and you pay any gap.",
        extras
          ? "Your extras cover may pay towards dental, physio and optical, usually after waiting periods and up to yearly limits."
          : "Your plan has no extras cover, so dental, physio and optical aren't covered.",
        VERIFY_WARNING,
      ].join(" "),
    );
  }

  if (agent === "explainer") {
    log("explainer", "matching", "get_score_breakdown", true, 70);
    return reply(
      "Clinics are ranked on seven things: whether they offer the service, your insurance, how soon they can see you, the estimated cost to you, distance, your saved preferences and patient ratings. Cost is the fee minus the Medicare rebate and any insurance benefit. Open a clinic's \"Why this clinic?\" to see each score.",
    );
  }

  // insights: approved facts only, with the visit they come from.
  log("insights", "patient_record", "get_approved_facts", true, 80);
  log("insights", "patient_record", "get_appointments", true, 60);
  const facts = await api.listClinicalFacts({ patientId, statuses: ["approved"] });
  const appointments = await api.listAppointments({ patientId, ascending: false });
  const text = message.toLowerCase();
  const fields = state.agent.clinical_fields;
  const topicWords: Record<string, RegExp> = {
    medication: /medic|tablet|supplement|iron|pill|dose|drug/,
    symptom: /symptom|tired|pain|feel/,
    plan: /follow|next|repeat|test|plan|come back/,
    allergy: /allerg/,
    observation: /blood pressure|weight|temperature|bp/,
  };
  const relevant = facts.filter((f) => {
    const field = fields.find((x) => x.id === f.field_id);
    const re = field ? topicWords[field.topic] : undefined;
    return re ? re.test(text) : false;
  });
  if (relevant.length) {
    const lines = relevant.map((f) => {
      const field = fields.find((x) => x.id === f.field_id);
      const a = appointments.find((x) => x.id === f.appointment_id);
      const value = typeof f.value === "object" && f.value ? Object.values(f.value as Record<string, unknown>).join(", ") : String(f.value);
      return `• ${field?.label ?? f.field_id}: ${value}${a ? ` (visit on ${formatDate(a.scheduled_start, a.facility.timezone)} with ${clinicianName(a.clinician)})` : ""}`;
    });
    return reply(
      `Here's what your clinician approved in your record:\n${lines.join("\n")}\nI can only repeat what's in your approved record; I can't give medical advice. If you'd like more detail, ask your clinician.`,
    );
  }
  const last = appointments.find((a) => a.status === "completed");
  if (!last) {
    return reply("I can't find that in your approved record, and you have no completed visits yet for me to send a question to a clinician.");
  }
  const question = message.replace(/\s+/g, " ").trim().replace(/[.!]*$/, "");
  return reply(
    `I can't find that in your approved record, so I won't guess. I can send this question to ${clinicianName(last.clinician)}, who you saw on ${formatDate(last.scheduled_start, last.facility.timezone)}. Nothing is sent until you approve it.`,
    { appointment_id: last.id, question: question.endsWith("?") ? question : `${question}?` },
  );
}

// --------------------------------------------------------------------------
// Discovery
// --------------------------------------------------------------------------
function quoteFor(state: MockState, patientId: Uuid | null, service: Service, facilityId: Uuid, now: Date) {
  const n = String(Number(facilityId.slice(-12)));
  const billing = state.facility_billing_policies.find((p) => p.facility_id === facilityId && validOn(p, now.toISOString().slice(0, 10)));
  const [fee, rebate] =
    PRICES[service.code]?.[n] ??
    (billing?.billing_policy === "bulk_billed" ? [43.9, 43.9] : service.code === "gp_long" ? [140, 76.5] : [85, 43.9]);
  const policy = patientId ? policyOn(state, patientId, now.toISOString().slice(0, 10)) : null;
  let coverage: CoverageStatus = "no_policy";
  const reasons: string[] = [];
  if (policy) {
    coverage = "not_covered";
    reasons.push(service.category === "specialist" ? "OUT_OF_HOSPITAL_SPECIALIST" : "MEDICARE_ONLY_SERVICE");
  }
  if (service.category === "specialist") reasons.push("REFERRAL_NEEDED_FOR_REBATE");
  const gap = round2(Math.max(0, fee - rebate));
  const insurance: InsuranceResult = {
    coverage_status: coverage,
    acceptance_status: policy ? "unknown" : "unknown",
    claim_mode: policy ? "not_supported" : "unknown",
    verification_level: policy ? "primary_extracted" : null,
    verification_required: !!policy,
    direct_billing_available: false,
    fee: money(fee),
    medicare_rebate: money(rebate),
    insurance_benefit: policy ? "0.00" : null,
    gap: money(gap),
    reason_codes: reasons,
    source_url: null,
    source_quote: null,
    coverage_as_of: now.toISOString(),
    disclaimer: VERIFY_WARNING,
  };
  return { fee, rebate, gap, insurance };
}

function discover(
  state: MockState,
  patientId: Uuid | null,
  service: Service,
  lat: number,
  lng: number,
  radiusKm: number,
  limit: number,
  now: Date,
): DiscoveryResponse {
  const nowIso = now.toISOString();
  const horizon = new Date(now.getTime() + 14 * 86_400_000).toISOString();
  const ratingOf = (clinicianId: Uuid) => {
    const rs = state.clinician_ratings.filter((r) => r.clinician_id === clinicianId && r.moderation_status === "visible");
    return rs.length ? { avg: rs.reduce((s, r) => s + r.rating, 0) / rs.length, n: rs.length } : null;
  };
  const cards: ClinicCard[] = [];
  let candidates = 0;
  for (const f of state.facilities) {
    if (!f.is_active || f.latitude === null || f.longitude === null) continue;
    const distance = round2(haversineKm({ lat, lng }, { lat: f.latitude, lng: f.longitude }));
    if (distance > radiusKm) continue;
    const today = localDate(now, f.timezone);
    const clinicians = state.clinician_affiliations
      .filter((a) => a.facility_id === f.id && validOn(a, today))
      .map((a) => state.clinicians.find((c) => c.id === a.clinician_id)!)
      .filter(
        (c) =>
          c?.is_active &&
          (service.required_specialty === "Dermatology"
            ? /derm|skin/i.test(c.specialty ?? "")
            : service.category === "dental"
              ? /dent/i.test(c.specialty ?? "")
              : c.clinician_type === "gp" || (service.code === "vaccination" && c.clinician_type === "nurse")),
      );
    const quote = quoteFor(state, patientId, service, f.id, now);
    const options: ProviderOption[] = [];
    for (const c of clinicians) {
      const slot = state.appointment_slots
        .filter((s) => s.clinician_id === c.id && s.facility_id === f.id && s.status === "available" && s.starts_at > nowIso && s.starts_at < horizon)
        .sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
      if (!slot) continue;
      candidates++;
      const hours = (Date.parse(slot.starts_at) - now.getTime()) / 3_600_000;
      const rating = ratingOf(c.id);
      const factors = {
        service: 1,
        insurance: quote.insurance.coverage_status === "no_policy" ? 0.5 : 0.4,
        availability: round2(Math.max(0, 1 - hours / (14 * 24))),
        cost: round2(Math.max(0, 1 - quote.gap / 150)),
        distance: round2(Math.max(0, 1 - distance / radiusKm)),
        preference: 0.5,
        rating: rating ? round2(rating.avg / 5) : 0.5,
      };
      const score = round2(
        factors.service * 0.2 + factors.insurance * 0.1 + factors.availability * 0.25 + factors.cost * 0.2 + factors.distance * 0.15 + factors.preference * 0.05 + factors.rating * 0.05,
      );
      options.push({
        clinician_id: c.id,
        clinician_name: clinicianName(c),
        specialty: c.specialty,
        languages: ["en"],
        offers_telehealth: false,
        next_slot_id: slot.id,
        next_slot_start: slot.starts_at,
        next_slot_local: slot.starts_at,
        fee: money(quote.fee),
        medicare_rebate: money(quote.rebate),
        insurance: quote.insurance,
        score,
        factors,
      });
    }
    if (!options.length) continue;
    options.sort((a, b) => b.score - a.score);
    const primary = options[0];
    const ratings = clinicians.map((c) => ratingOf(c.id)).filter((r): r is { avg: number; n: number } => !!r);
    const reviewCount = ratings.reduce((s, r) => s + r.n, 0);
    cards.push({
      facility_id: f.id,
      facility_name: f.name,
      description: `${service.name} at ${f.name}, ${f.suburb}.`,
      address_line1: f.address_line1,
      suburb: f.suburb,
      state: f.state,
      postcode: f.postcode,
      timezone: f.timezone,
      latitude: f.latitude,
      longitude: f.longitude,
      distance_km: distance,
      rating: reviewCount ? round2(ratings.reduce((s, r) => s + r.avg * r.n, 0) / reviewCount) : null,
      review_count: reviewCount,
      service_code: service.code,
      score: primary.score,
      rank: 0,
      flags: [],
      category_ranks: {},
      primary_option: primary,
      options,
      agent_description:
        `${primary.clinician_name} can see you ${formatDateTime(primary.next_slot_start, f.timezone)}. ` +
        `Estimated out-of-pocket cost ${formatMoney(quote.gap)} after the Medicare rebate` +
        `${quote.insurance.coverage_status === "not_covered" ? "; your private cover doesn't pay for this service" : ""}. ` +
        `${distance.toFixed(1)} km away.`,
    });
  }
  cards.sort((a, b) => b.score - a.score);
  cards.forEach((c, i) => (c.rank = i + 1));
  const by = (key: (c: ClinicCard) => number) => [...cards].sort((a, b) => key(a) - key(b)).map((c) => c.facility_id);
  const rankings = {
    soonest: by((c) => Date.parse(c.primary_option.next_slot_start)),
    cheapest: by((c) => Number(c.primary_option.insurance.gap ?? 0)),
    nearest: by((c) => c.distance_km),
  };
  for (const c of cards) {
    for (const [name, ids] of Object.entries(rankings)) {
      c.category_ranks[name] = ids.indexOf(c.facility_id) + 1;
      if (ids[0] === c.facility_id && cards.length > 1) c.flags.push(name);
    }
  }
  return {
    request_id: crypto.randomUUID(),
    generated_at: nowIso,
    service,
    search_radius_km: radiusKm,
    candidate_count: candidates,
    returned_count: Math.min(limit, cards.length),
    ranking_version: "mock-v1",
    category_rankings: rankings,
    clinics: cards.slice(0, limit),
  };
}
