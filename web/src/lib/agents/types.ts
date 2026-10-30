// Contracts of the Python services (src/healthmcp): the agent service
// (agent.py: /chat, /chat/confirm) and the discovery API (discovery/models.py).
// Pydantic sends Decimal as a string, so money arrives as "85.00".
export type Money = string | null;
export type AgentRole = "explainer" | "extractor" | "insights" | "insurance" | "insights-writer";

export interface ChatRequest {
  message: string;
  reason_facts?: string[];
  context_fact_ids?: string[];
}
export interface ChatResponse {
  agent: AgentRole;
  answer: string;
  pending_action: string | null; // signed GP-question draft; only the patient can confirm it
  appointment_id: string | null;
}
export interface ConfirmResponse {
  status: "created";
  result: unknown;
}

export type CoverageStatus =
  | "covered"
  | "partially_covered"
  | "not_covered"
  | "waiting_period"
  | "limit_reached"
  | "pre_auth_required"
  | "no_policy"
  | "unknown";
export type AcceptanceStatus = "accepted" | "not_accepted" | "unknown";
export type ClaimMode = "direct" | "manual" | "not_supported" | "unknown";
export type VerificationLevel = "verified" | "primary_extracted" | "fallback_unverified";

export interface Service {
  id: string;
  code: string;
  name: string;
  category: string;
  insurance_category: string | null;
  required_specialty: string | null;
  default_duration_minutes: number;
}

export interface DiscoveryRequest {
  service_code?: string | null;
  problem_text?: string | null;
  latitude: number;
  longitude: number;
  max_distance_km?: number;
  date_from?: string | null;
  date_to?: string | null;
  limit?: number;
  include_agent_descriptions?: boolean;
}

export interface InsuranceResult {
  coverage_status: CoverageStatus;
  acceptance_status: AcceptanceStatus;
  claim_mode: ClaimMode;
  verification_level: VerificationLevel | null;
  verification_required: boolean;
  direct_billing_available: boolean;
  fee: Money;
  medicare_rebate: Money;
  insurance_benefit: Money;
  gap: Money;
  reason_codes: string[];
  source_url: string | null;
  source_quote: string | null;
  coverage_as_of: string | null;
  disclaimer: string | null;
}

export interface FactorScores {
  service: number;
  insurance: number;
  availability: number;
  cost: number;
  distance: number;
  preference: number;
  rating: number;
}

export interface ProviderOption {
  clinician_id: string;
  clinician_name: string;
  specialty: string | null;
  languages: string[];
  offers_telehealth: boolean;
  next_slot_id: string;
  next_slot_start: string;
  next_slot_local: string;
  fee: Money;
  medicare_rebate: Money;
  insurance: InsuranceResult;
  score: number;
  factors: FactorScores;
}

export interface ClinicCard {
  facility_id: string;
  facility_name: string;
  description: string;
  address_line1: string;
  suburb: string;
  state: string;
  postcode: string;
  timezone: string;
  latitude: number | null;
  longitude: number | null;
  distance_km: number;
  rating: number | null;
  review_count: number;
  service_code: string;
  score: number;
  rank: number;
  flags: string[];
  category_ranks: Record<string, number>;
  primary_option: ProviderOption;
  options: ProviderOption[];
  agent_description: string | null;
}

export interface DiscoveryResponse {
  request_id: string;
  generated_at: string;
  service: Service;
  search_radius_km: number;
  candidate_count: number;
  returned_count: number;
  ranking_version: string;
  category_rankings: Record<string, string[]>;
  clinics: ClinicCard[];
}

export interface AvailabilitySlot {
  slot_id: string;
  facility_id: string;
  facility_name: string;
  clinician_id: string;
  clinician_name: string;
  starts_at: string;
  ends_at: string;
  local_start: string;
  timezone: string;
}

export interface SlotHoldResponse {
  slot_id: string;
  held_until: string;
}

export interface BookingRequest {
  slot_id: string;
  service_code: string;
  reason?: string | null;
  idempotency_key: string;
  expected_fee?: string | null;
  expected_gap?: string | null;
}

export interface BookingResponse {
  appointment_id: string;
  status: string;
  scheduled_start: string;
  facility_id: string;
  clinician_id: string;
  service_code: string;
  quoted_fee: Money;
  quoted_gap: Money;
  coverage_status: CoverageStatus;
  claim_mode: ClaimMode;
}

export interface ResearchDraftSummary {
  id: string;
  kind: "coverage" | "acceptance";
  status: string;
  plan_id: string | null;
  facility_id: string | null;
  insurer_provider_id: string | null;
  service_id: string | null;
  insurance_category: string | null;
  coverage_status: CoverageStatus | null;
  accepted: boolean | null;
  claim_mode: ClaimMode | null;
  source_type: string;
  source_url: string | null;
  evidence_quote: string;
  confidence: number;
  created_at: string;
}

/** Error body from either service, normalised by the proxy. */
export interface AgentErrorBody {
  error: string; // e.g. NEEDS_SERVICE_CLARIFICATION, SLOT_TAKEN, QUOTE_CHANGED, unavailable
  message?: string;
  candidates?: { code: string; name: string; category: string }[];
  expected_gap?: string | null;
  current_gap?: string | null;
}
