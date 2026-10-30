"use client";
// Browser calls to the agent service and discovery API, always through the
// same-origin proxy (/api/agents/...), which adds the user's token.
import type {
  AgentErrorBody,
  AvailabilitySlot,
  BookingRequest,
  BookingResponse,
  ChatRequest,
  ChatResponse,
  ConfirmResponse,
  DiscoveryRequest,
  DiscoveryResponse,
  ResearchDraftSummary,
  Service,
  SlotHoldResponse,
} from "./types";

export class AgentError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly body: AgentErrorBody,
  ) {
    super(code);
    this.name = "AgentError";
  }
}

async function call<T>(path: string, init: { method: "GET" | "POST"; body?: unknown; query?: Record<string, string | undefined> }): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(init.query ?? {})) if (v) qs.set(k, v);
  const res = await fetch(`/api/agents/${path}${qs.size ? `?${qs}` : ""}`, {
    method: init.method,
    headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => ({ error: "upstream_error" }))) as T | AgentErrorBody;
  if (!res.ok) {
    const body = (json && typeof json === "object" && "error" in json ? json : { error: "upstream_error" }) as AgentErrorBody;
    throw new AgentError(body.error, res.status, body);
  }
  return json as T;
}

export const agents = {
  chat: (body: ChatRequest) => call<ChatResponse>("chat", { method: "POST", body }),
  confirm: (action: string) => call<ConfirmResponse>("chat/confirm", { method: "POST", body: { action } }),
  services: () => call<Service[]>("services", { method: "GET" }),
  discover: (body: DiscoveryRequest) => call<DiscoveryResponse>("discovery", { method: "POST", body }),
  availability: (q: { date: string; facility_id?: string; clinician_id?: string }) =>
    call<AvailabilitySlot[]>("availability", { method: "GET", query: q }),
  hold: (slotId: string) => call<SlotHoldResponse>("holds", { method: "POST", body: { slot_id: slotId } }),
  book: (body: BookingRequest) => call<BookingResponse>("bookings", { method: "POST", body }),
  researchDrafts: (status: "pending" | "approved" | "rejected" | "all" = "pending") =>
    call<ResearchDraftSummary[]>("research/drafts", { method: "GET", query: { status } }),
  approveResearchDraft: (id: string) => call<{ draft_id: string; rule_id: string }>(`research/drafts/${id}/approve`, { method: "POST", body: {} }),
  rejectResearchDraft: (id: string, reason: string | null) =>
    call<void>(`research/drafts/${id}/reject`, { method: "POST", body: { reason } }),
};

/** Sentences for the agent and discovery error codes. */
export function agentErrorMessage(err: unknown): string {
  if (!(err instanceof AgentError)) return "Something went wrong. Please try again.";
  switch (err.code) {
    case "unavailable":
      return "The assistant isn't available right now. Please try again shortly.";
    case "unauthorized":
    case "UNAUTHORIZED":
      return "Your session has ended. Please sign in again.";
    case "request_too_large":
      return "That message is too long.";
    case "SLOT_TAKEN":
      return "Someone else just took that time. Please choose another.";
    case "QUOTE_CHANGED":
      return "The estimated cost changed since you looked. Please check the new price before booking.";
    case "COVERAGE_CHANGED":
      return "Your insurance details changed. Please search again.";
    case "NO_INSURANCE_POLICY":
      return "There's no insurance policy on your profile.";
    case "SERVICE_NOT_FOUND":
      return "We couldn't find that service.";
    case "STAFF_REQUIRED":
    case "FORBIDDEN":
      return "You don't have permission to do that.";
    case "agent_error":
    case "upstream_error":
      return "The assistant ran into a problem. Please try again.";
    default:
      return "Something went wrong. Please try again.";
  }
}
