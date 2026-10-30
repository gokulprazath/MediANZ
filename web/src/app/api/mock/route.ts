// Mock mode only: runs one DataApi method against the in-memory mock database
// as the signed-in mock user (RLS is emulated in src/lib/mock/store.ts).
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { DATA_API_METHODS, DataError, type DataApi } from "@/lib/data/api";
import { IS_MOCK } from "@/lib/env";
import { decodeMockSession, MOCK_SESSION_COOKIE } from "@/lib/mock/session";
import { getMockState } from "@/lib/mock/server-state";
import { createMockApi, slotSnapshot } from "@/lib/mock/store";

const METHODS = new Set<string>(DATA_API_METHODS);

export async function POST(request: Request) {
  if (!IS_MOCK) return new NextResponse(null, { status: 404 });
  const session = decodeMockSession((await cookies()).get(MOCK_SESSION_COOKIE)?.value);
  const body = (await request.json().catch(() => null)) as { method?: string; args?: unknown[] } | null;
  const method = body?.method ?? "";
  const args = Array.isArray(body?.args) ? body.args : [];
  const state = getMockState();

  if (method === "__slotSnapshot") {
    if (!session) return NextResponse.json({ error: { message: "Signed out", code: "PGRST301" } }, { status: 401 });
    return NextResponse.json({ data: slotSnapshot(state, String(args[0])) });
  }
  if (!METHODS.has(method)) {
    return NextResponse.json({ error: { message: "Unknown method", code: "400" } }, { status: 400 });
  }

  try {
    const api = createMockApi(state, session?.uid ?? null);
    const fn = api[method as keyof DataApi] as (...a: unknown[]) => Promise<unknown>;
    const data = await fn(...args);
    return NextResponse.json({ data: data ?? null }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const e = err instanceof DataError ? err : new DataError(String((err as Error)?.message ?? err), "500");
    return NextResponse.json({ error: { message: e.message, code: e.code } }, { status: 400 });
  }
}
