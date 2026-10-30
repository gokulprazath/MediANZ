// Proxy from the browser to the Python agent service and discovery API.
// Live: forwards the signed-in user's Supabase access token, so the services
// (and RLS behind them) decide what the user may see and do. The service URLs
// stay on the server. Mock: answered by lib/mock/agents.ts, offline.
// Bodies are never logged: they can hold health questions.
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { ALLOWED_QUERY, resolveAgentRoute } from "@/lib/agents/routes";
import { upstreamBase } from "@/lib/agents/upstream";
import { IS_MOCK } from "@/lib/env";
import { handleMockAgentRequest } from "@/lib/mock/agents";
import { decodeMockSession, MOCK_SESSION_COOKIE } from "@/lib/mock/session";
import { getMockState } from "@/lib/mock/server-state";
import { getServerSupabase } from "@/lib/supabase/server";

const MAX_BODY = 32 * 1024;
const TIMEOUT_MS = 60_000;

const json = (body: unknown, status: number) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function handle(request: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const route = resolveAgentRoute(request.method, path);
  if (!route) return json({ error: "not_found" }, 404);

  const url = new URL(request.url);
  const query = new URLSearchParams();
  for (const k of ALLOWED_QUERY[route.path] ?? []) {
    const v = url.searchParams.get(k);
    if (v !== null) query.set(k, v.slice(0, 64));
  }

  let body: unknown = undefined;
  if (route.method === "POST") {
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ error: "request_too_large" }, 413);
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
  }

  if (IS_MOCK) {
    const session = decodeMockSession((await cookies()).get(MOCK_SESSION_COOKIE)?.value);
    if (!session) return json({ error: "unauthorized" }, 401);
    const res = await handleMockAgentRequest(getMockState(), session.uid, route.path, route.method, body, query);
    return json(res.body, res.status);
  }

  const base = upstreamBase(route.upstream);
  if (!base) return json({ error: "unavailable", message: `${route.upstream} service is not configured` }, 503);
  const supabase = await getServerSupabase();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) return json({ error: "unauthorized" }, 401);

  try {
    const res = await fetch(`${base}${route.path}${query.size ? `?${query}` : ""}`, {
      method: route.method,
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        ...(route.method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      body: route.method === "POST" ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 204) return new NextResponse(null, { status: 204 });
    const payload = await res.json().catch(() => ({ error: "upstream_error" }));
    // FastAPI's HTTPException shape is {detail}; normalise to {error}.
    if (!res.ok && payload && typeof payload === "object" && "detail" in payload && !("error" in payload)) {
      const detail = (payload as { detail: unknown }).detail;
      return json({ error: typeof detail === "string" ? detail : "invalid_request" }, res.status);
    }
    return json(payload, res.status);
  } catch {
    return json({ error: "unavailable" }, 503);
  }
}

export const GET = handle;
export const POST = handle;
