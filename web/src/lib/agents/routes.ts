// The only agent and discovery endpoints the browser may reach, through
// /api/agents/... (the proxy adds the signed-in user's token). Anything else
// is refused, so the browser can't call research jobs or internal endpoints.
export type Upstream = "agent" | "discovery";

export interface AgentRoute {
  upstream: Upstream;
  method: "GET" | "POST";
  path: string; // upstream path
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const TABLE: { method: "GET" | "POST"; pattern: RegExp; upstream: Upstream; to: (m: RegExpMatchArray) => string }[] = [
  { method: "POST", pattern: /^chat$/, upstream: "agent", to: () => "/chat" },
  { method: "POST", pattern: /^chat\/confirm$/, upstream: "agent", to: () => "/chat/confirm" },
  { method: "GET", pattern: /^services$/, upstream: "discovery", to: () => "/v1/services" },
  { method: "POST", pattern: /^discovery$/, upstream: "discovery", to: () => "/v1/discovery" },
  { method: "GET", pattern: /^availability$/, upstream: "discovery", to: () => "/v1/availability" },
  { method: "POST", pattern: /^holds$/, upstream: "discovery", to: () => "/v1/holds" },
  { method: "POST", pattern: /^bookings$/, upstream: "discovery", to: () => "/v1/bookings" },
  { method: "GET", pattern: /^research\/drafts$/, upstream: "discovery", to: () => "/v1/research/drafts" },
  {
    method: "POST",
    pattern: new RegExp(`^research/drafts/(${UUID})/(approve|reject)$`, "i"),
    upstream: "discovery",
    to: (m) => `/v1/research/drafts/${m[1]}/${m[2]}`,
  },
];

export function resolveAgentRoute(method: string, segments: string[]): (AgentRoute & { match: RegExpMatchArray }) | null {
  const joined = segments.join("/");
  for (const r of TABLE) {
    if (r.method !== method) continue;
    const m = joined.match(r.pattern);
    if (m) return { upstream: r.upstream, method: r.method, path: r.to(m), match: m };
  }
  return null;
}

/** Query parameters passed through for GET endpoints. */
export const ALLOWED_QUERY: Record<string, string[]> = {
  "/v1/availability": ["date", "facility_id", "clinician_id"],
  "/v1/research/drafts": ["status", "limit"],
};
