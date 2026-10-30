// Part B: agent-layer review rules, self check-in, operations summaries, and
// the offline stand-ins for the agent and discovery services.
import { beforeEach, describe, expect, it } from "vitest";
import { resolveAgentRoute } from "@/lib/agents/routes";
import { upstreamBase } from "@/lib/agents/upstream";
import { readPendingAction } from "@/lib/agents/pending-action";
import type { ChatResponse, DiscoveryResponse } from "@/lib/agents/types";
import type { DataApi } from "@/lib/data/api";
import { handleMockAgentRequest, resolveService, routeQuestion } from "@/lib/mock/agents";
import { APPT, buildSeed, PAT, type MockState } from "@/lib/mock/seed";
import { createMockApi } from "@/lib/mock/store";
import { authId } from "@/lib/mock/users";
import { buildValue, editorFields, factValueText } from "@/features/review/values";

const NOW = new Date("2026-10-30T01:00:00Z");
let state: MockState;
let olivia: DataApi;
let jack: DataApi;
let rao: DataApi;
let sophie: DataApi;
let staff: DataApi;

beforeEach(() => {
  state = buildSeed(NOW);
  const make = (n: number) => createMockApi(state, authId(n), { now: () => NOW });
  olivia = make(1);
  jack = make(2);
  rao = make(11);
  sophie = make(13);
  staff = make(21);
});

describe("review queue rules", () => {
  it("drafts are visible to the treating clinician and staff, never to the patient or another clinician", async () => {
    const drafts = await rao.listKeyPoints({ statuses: ["draft"] });
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.every((k) => k.appointment_id === APPT(2))).toBe(true);
    expect(await olivia.listKeyPoints({ statuses: ["draft"] })).toHaveLength(0);
    expect(await sophie.listKeyPoints()).toHaveLength(0);
    expect((await staff.listClinicalFacts({ statuses: ["draft"] })).length).toBeGreaterThan(0);
    await expect(sophie.approveKeyPoint(drafts[0].id)).rejects.toMatchObject({ code: "42501" });
  });

  it("approve, correct and reject; the patient then sees approved facts only", async () => {
    const facts = await rao.listClinicalFacts({ statuses: ["draft"] });
    const med = facts.find((f) => f.field_id === "current_medication")!;
    const symptom = facts.find((f) => f.field_id === "symptom")!;
    await rao.editAndApproveFact(med.id, { name: "Ferrous sulfate", dose: "325 mg", frequency: "Once a day" });
    await rao.rejectFact(symptom.id);
    await expect(rao.approveFact(med.id)).rejects.toThrow(/not a draft/);
    const mine = await olivia.listClinicalFacts({ patientId: PAT(1) });
    expect(mine.map((f) => f.field_id)).toEqual(["current_medication"]);
    expect(mine[0]).toMatchObject({ status: "approved", value_edited: true });

    const [kp] = (await rao.listKeyPoints({ statuses: ["draft"] })).filter((k) => k.kind === "yes_no");
    await expect(rao.editAndApproveKeyPoint(kp.id, "maybe")).rejects.toThrow(/not an option/);
    await rao.editAndApproveKeyPoint(kp.id, "no");
    expect((await olivia.listKeyPoints()).find((k) => k.id === kp.id)).toMatchObject({ answer: "no", answer_edited: true });
  });

  it("open items are resolved and GP questions answered; the patient reads the answer", async () => {
    const [item] = await rao.listOpenItems({ statuses: ["open"] });
    await rao.resolveOpenItem(item.id, "Dose confirmed: 325 mg daily");
    expect(await rao.listOpenItems({ statuses: ["open"] })).toHaveLength(0);
    const [q] = await olivia.listGpQueries();
    expect(q.status).toBe("open");
    await expect(olivia.answerGpQuery(q.id, "x")).rejects.toMatchObject({ code: "42501" });
    await rao.answerGpQuery(q.id, "Yes, but wait an hour after coffee for better absorption.");
    expect((await olivia.listGpQueries())[0]).toMatchObject({ status: "answered" });
    expect(await jack.listGpQueries()).toHaveLength(0);
  });

  it("approving a transcript runs the documentation agent", async () => {
    const before = (await sophie.listKeyPoints({ statuses: ["draft"] })).length;
    const lukas = createMockApi(state, authId(6), { now: () => NOW });
    const [t] = (await lukas.listTranscripts()).filter((x) => x.status === "pending_patient_review");
    await lukas.approveTranscript(t.id);
    expect((await sophie.listKeyPoints({ statuses: ["draft"] })).length).toBeGreaterThan(before);
    expect((await sophie.listClinicalFacts({ statuses: ["draft"] })).some((f) => JSON.stringify(f.value).includes("Ankle"))).toBe(true);
    const [run] = await sophie.listConsultNoteRuns([t.appointment_id]);
    expect(run.status).toBe("done");
  });
});

describe("patient self check-in", () => {
  it("only the patient, only from 30 minutes before to 15 after", async () => {
    const a = (await olivia.getAppointment(APPT(101)))!;
    const at = (ms: number) => createMockApi(state, authId(1), { now: () => new Date(Date.parse(a.scheduled_start) + ms) });
    await expect(at(-45 * 60_000).patientCheckIn(a.id)).rejects.toThrow(/opens 30 minutes before/);
    await expect(createMockApi(state, authId(2), { now: () => new Date(a.scheduled_start) }).patientCheckIn(a.id)).rejects.toThrow(/not found/);
    await at(-10 * 60_000).patientCheckIn(a.id);
    expect((await olivia.getAppointment(a.id))?.status).toBe("checked_in");
    await expect(at(-5 * 60_000).patientCheckIn(a.id)).rejects.toThrow(/Only a booked appointment/);
  });
});

describe("operations summaries", () => {
  it("are staff-only aggregates", async () => {
    await expect(rao.getAgentActivity(24)).rejects.toMatchObject({ code: "42501" });
    const rows = await staff.getAgentActivity(24 * 30);
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0]).sort()).toEqual(["agent_id", "avg_latency_ms", "calls", "errors", "last_call_at", "p95_latency_ms", "server", "tool"]);
    expect(rows.some((r) => r.errors > 0)).toBe(true);
    expect((await staff.listModelRegistry()).length).toBeGreaterThan(0);
    expect(await olivia.listModelRegistry()).toEqual([]);
  });
});

describe("agent proxy allowlist", () => {
  it("maps only the known endpoints", () => {
    expect(resolveAgentRoute("POST", ["chat"])?.path).toBe("/chat");
    expect(resolveAgentRoute("POST", ["chat", "confirm"])).toMatchObject({ upstream: "agent", path: "/chat/confirm" });
    expect(resolveAgentRoute("POST", ["discovery"])).toMatchObject({ upstream: "discovery", path: "/v1/discovery" });
    expect(resolveAgentRoute("GET", ["discovery"])).toBeNull();
    expect(resolveAgentRoute("POST", ["extract"])).toBeNull();
    expect(resolveAgentRoute("POST", ["research", "drafts", "79000000-0000-4000-8000-000000000001", "approve"])?.path).toBe(
      "/v1/research/drafts/79000000-0000-4000-8000-000000000001/approve",
    );
    expect(resolveAgentRoute("POST", ["research", "drafts", "../../admin", "approve"])).toBeNull();
  });
});

describe("proxy upstreams", () => {
  it("uses the Vercel binding to the one backend service, else the two local services", () => {
    const vercel = { BACKEND_URL: "https://backend.internal", AGENT_SERVICE_URL: "http://localhost:3108" };
    expect(`${upstreamBase("agent", vercel)}/chat`).toBe("https://backend.internal/agent/chat");
    expect(`${upstreamBase("discovery", { BACKEND_URL: "https://b.internal/x/" })}/v1/services`).toBe(
      "https://b.internal/x/discovery/v1/services",
    );
    const local = { AGENT_SERVICE_URL: "http://localhost:3108/", DISCOVERY_SERVICE_URL: "http://localhost:3109" };
    expect(upstreamBase("agent", local)).toBe("http://localhost:3108");
    expect(upstreamBase("discovery", local)).toBe("http://localhost:3109");
    expect(upstreamBase("agent", {})).toBe("");
  });
});

describe("mock agents", () => {
  it("routes like agent.py and matches services from plain words", () => {
    expect(routeQuestion("Does my insurance cover this?")).toBe("insurance");
    expect(routeQuestion("What medication did my GP start?")).toBe("insights");
    expect(routeQuestion("Why is this clinic's fee higher?")).toBe("explainer");
    expect(routeQuestion("Can you book me in with a GP tomorrow?")).toBe("booking");
    expect(routeQuestion("Is a booking covered by my insurance?")).toBe("insurance");
    expect(routeQuestion("When is my next appointment?")).toBe("insights");
    // Whole words: "fee" never catches "coffee" or "feeling".
    expect(routeQuestion("Can I drink coffee with my iron tablets?")).toBe("insights");
    expect(routeQuestion("Why have I been feeling so tired?")).toBe("insights");
    // Follow-ups route like the earlier patient message.
    expect(routeQuestion("yes please", ["Book me a GP on Friday"])).toBe("booking");
    expect(routeQuestion("thanks")).toBe("insights");
    expect(resolveService(null, "I'd like a skin check for a mole")?.code).toBe("skin_check");
    expect(resolveService(null, "need my flu shot")?.code).toBe("vaccination");
    expect(resolveService(null, "something odd")).toBeNull();
  });

  it("drafts a GP question that is created only on confirm", async () => {
    const q = new URLSearchParams();
    const chat = await handleMockAgentRequest(state, authId(1), "/chat", "POST", { message: "What medication did my GP start?" }, q);
    const body = chat.body as ChatResponse;
    expect(body.agent).toBe("insights");
    expect(body.pending_action).toBeTruthy(); // nothing approved yet, so it asks the GP
    const preview = readPendingAction(body.pending_action!);
    expect(preview?.question).toBe("What medication did my GP start?");
    const before = state.agent.gp_queries.length;
    expect((await handleMockAgentRequest(state, authId(2), "/chat/confirm", "POST", { action: body.pending_action }, q)).status).toBe(401);
    expect(state.agent.gp_queries.length).toBe(before);
    const ok = await handleMockAgentRequest(state, authId(1), "/chat/confirm", "POST", { action: body.pending_action }, q);
    expect(ok.status).toBe(200);
    expect(state.agent.gp_queries.length).toBe(before + 1);

    // After the clinician approves the medication fact, the records agent answers from it.
    const med = (await rao.listClinicalFacts({ statuses: ["draft"] })).find((f) => f.field_id === "current_medication")!;
    await rao.approveFact(med.id);
    const again = (await handleMockAgentRequest(state, authId(1), "/chat", "POST", { message: "What medication did my GP start?" }, q)).body as ChatResponse;
    expect(again.pending_action).toBeNull();
    expect(again.answer).toContain("Iron supplement");
  });

  it("proposes a booking that only the patient's confirm books", async () => {
    const q = new URLSearchParams();
    const before = state.appointments.length;
    const chat = (await handleMockAgentRequest(state, authId(2), "/chat", "POST", { message: "Book me the next available GP appointment" }, q))
      .body as ChatResponse;
    expect(chat.agent).toBe("booking");
    const proposal = chat.booking_proposal!;
    expect(proposal.summary).toMatch(/^Book /);
    expect(state.appointments.length).toBe(before); // proposing books nothing
    await expect(olivia.confirmBookingProposal(proposal.proposal_id)).rejects.toThrow(/Proposal not found/);
    const appointmentId = await jack.confirmBookingProposal(proposal.proposal_id);
    expect(state.appointments.length).toBe(before + 1);
    expect(state.appointments.find((a) => a.id === appointmentId)?.patient_id).toBe(PAT(2));
    await expect(jack.confirmBookingProposal(proposal.proposal_id)).rejects.toThrow(/no longer pending/);

    const next = (await handleMockAgentRequest(state, authId(2), "/chat", "POST", { message: "book a GP" }, q)).body as ChatResponse;
    await jack.declineBookingProposal(next.booking_proposal!.proposal_id);
    await expect(jack.confirmBookingProposal(next.booking_proposal!.proposal_id)).rejects.toThrow(/no longer pending/);
    expect(state.appointments.length).toBe(before + 1);
  });

  it("discovers, holds and books with the quoted gap, idempotently", async () => {
    const q = new URLSearchParams();
    const res = await handleMockAgentRequest(state, authId(2), "/v1/discovery", "POST", { problem_text: "sore back", latitude: -27.4785, longitude: 153.0206, max_distance_km: 20 }, q);
    expect(res.status).toBe(200);
    const d = res.body as DiscoveryResponse;
    expect(d.service.code).toBe("gp_standard");
    expect(d.clinics.length).toBeGreaterThan(0);
    expect(d.clinics.map((c) => c.rank)).toEqual(d.clinics.map((_, i) => i + 1));
    const card = d.clinics[0];
    const slot = card.primary_option.next_slot_id;
    expect((await handleMockAgentRequest(state, authId(2), "/v1/holds", "POST", { slot_id: slot }, q)).status).toBe(200);
    const changed = await handleMockAgentRequest(state, authId(2), "/v1/bookings", "POST", { slot_id: slot, service_code: "gp_standard", idempotency_key: "key-12345", expected_gap: "1.00" }, q);
    expect(changed).toMatchObject({ status: 409, body: { error: "QUOTE_CHANGED", current_gap: card.primary_option.insurance.gap } });
    const book = { slot_id: slot, service_code: "gp_standard", idempotency_key: "key-12345", expected_gap: card.primary_option.insurance.gap };
    const first = await handleMockAgentRequest(state, authId(2), "/v1/bookings", "POST", book, q);
    const second = await handleMockAgentRequest(state, authId(2), "/v1/bookings", "POST", book, q);
    expect(first.status).toBe(201);
    expect((second.body as { appointment_id: string }).appointment_id).toBe((first.body as { appointment_id: string }).appointment_id);
    const clarify = await handleMockAgentRequest(state, authId(2), "/v1/discovery", "POST", { problem_text: "hmm", latitude: -27.4, longitude: 153 }, q);
    expect(clarify).toMatchObject({ status: 422, body: { error: "NEEDS_SERVICE_CLARIFICATION" } });
  });

  it("research drafts are staff only", async () => {
    const q = new URLSearchParams();
    expect((await handleMockAgentRequest(state, authId(1), "/v1/research/drafts", "GET", undefined, q)).status).toBe(403);
    const list = await handleMockAgentRequest(state, authId(21), "/v1/research/drafts", "GET", undefined, q);
    expect((list.body as unknown[]).length).toBe(2);
  });
});

describe("fact value editor", () => {
  it("builds values from the field schema", () => {
    const field = state.agent.clinical_fields.find((f) => f.id === "current_medication")!;
    const fields = editorFields(field);
    expect(fields.map((f) => f.key)).toEqual(["name", "dose", "frequency"]);
    expect(buildValue(fields, { name: "Iron", dose: "", frequency: "Daily" })).toEqual({ name: "Iron", frequency: "Daily" });
    expect(buildValue(fields, { name: "" })).toBeNull();
    const temp = editorFields(state.agent.clinical_fields.find((f) => f.id === "body_temperature"));
    expect(buildValue(temp, { "": "37.2" })).toBe(37.2);
    expect(factValueText({ name: "Iron", frequency: "Daily" })).toBe("name: Iron · frequency: Daily");
  });
});
