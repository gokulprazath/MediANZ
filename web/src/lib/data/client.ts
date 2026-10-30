"use client";
// The browser's DataApi: live (supabase-js) or mock (the in-memory database on
// the Next.js server, reached through /api/mock).
import { IS_MOCK } from "@/lib/env";
import { getBrowserSupabase } from "@/lib/supabase/browser";
import { DATA_API_METHODS, DataError, type DataApi, type SlotChange, type SubscribeSlots } from "./api";
import { createLiveApi, createLiveSlotSubscription } from "./live";

async function mockRequest<T>(method: string, args: unknown[]): Promise<T> {
  const res = await fetch("/api/mock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, args }),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: { message: string; code: string | null } };
  if (json.error) throw new DataError(json.error.message, json.error.code, res.status);
  if (!res.ok) throw new DataError(`Request failed (${res.status})`, String(res.status), res.status);
  return json.data as T;
}

function createMockRemoteApi(): DataApi {
  const api = {} as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const method of DATA_API_METHODS) {
    api[method] = (...args: unknown[]) =>
      // Audio never leaves the browser in mock mode: only its size and type are sent.
      mockRequest(
        method,
        args.map((a) => (typeof Blob !== "undefined" && a instanceof Blob ? { size: a.size, type: a.type } : a)),
      );
  }
  return api as unknown as DataApi;
}

// Mock mode: poll the slot list every 2 seconds and report changes, in place
// of Supabase Realtime.
const mockSubscribeSlots: SubscribeSlots = (clinicianId, onChange) => {
  let last = new Map<string, string>();
  let first = true;
  let stopped = false;
  const tick = async () => {
    try {
      const slots = await mockRequest<SlotChange["slot"][]>("__slotSnapshot", [clinicianId]);
      const next = new Map(slots.map((s) => [s.id, JSON.stringify(s)]));
      if (!first) {
        for (const s of slots) if (last.get(s.id) !== next.get(s.id)) onChange({ slot: s });
      }
      first = false;
      last = next;
    } catch {
      // try again on the next tick
    }
  };
  void tick();
  const timer = setInterval(() => !stopped && void tick(), 2000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
};

let browserApi: DataApi | null = null;
let subscribe: SubscribeSlots | null = null;

export function getBrowserApi(): DataApi {
  browserApi ??= IS_MOCK ? createMockRemoteApi() : createLiveApi(getBrowserSupabase());
  return browserApi;
}

export function getSlotSubscription(): SubscribeSlots {
  subscribe ??= IS_MOCK ? mockSubscribeSlots : createLiveSlotSubscription(getBrowserSupabase());
  return subscribe;
}
