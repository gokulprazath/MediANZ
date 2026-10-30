"use client";
// Data that changes while a screen is open (appointment status, consents,
// recording state, GP questions). Mock mode polls every 5 seconds while the
// page is visible. Live mode with `realtime` also subscribes to Supabase
// Realtime (tables published by 20261030000000_partb_live_agents.sql; RLS
// applies) and refetches on every change, so polling becomes a slow fallback.
import { useQuery, useQueryClient, type QueryKey, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query";
import { useEffect } from "react";
import { IS_MOCK } from "@/lib/env";
import { getBrowserSupabase } from "@/lib/supabase/browser";

export const LIVE_POLL_MS = 5000;
export const REALTIME_FALLBACK_POLL_MS = 30_000;

export interface RealtimeSource {
  // consult_note_runs is published by 20261028000000_consult_key_points.sql.
  table: "appointments" | "recording_consents" | "recording_sessions" | "gp_queries" | "consult_note_runs";
  filter?: string; // e.g. "id=eq.<uuid>" or "appointment_id=eq.<uuid>"
}

export function useLiveQuery<T>(
  key: QueryKey,
  fn: () => Promise<T>,
  options: { intervalMs?: number; enabled?: boolean; realtime?: RealtimeSource[] } & Omit<
    UseQueryOptions<T>,
    "queryKey" | "queryFn" | "refetchInterval"
  > = {},
): UseQueryResult<T> {
  const { intervalMs = LIVE_POLL_MS, realtime, ...rest } = options;
  const qc = useQueryClient();
  const useRealtime = !IS_MOCK && !!realtime?.length && rest.enabled !== false;
  const keyText = JSON.stringify(key);
  const sourcesText = JSON.stringify(realtime ?? []);

  useEffect(() => {
    if (!useRealtime) return;
    const sources = JSON.parse(sourcesText) as RealtimeSource[];
    const sb = getBrowserSupabase();
    let channel = sb.channel(`live:${keyText}:${crypto.randomUUID()}`);
    for (const s of sources) {
      channel = channel.on("postgres_changes", { event: "*", schema: "public", table: s.table, filter: s.filter }, () => {
        void qc.invalidateQueries({ queryKey: JSON.parse(keyText) as QueryKey });
      });
    }
    channel.subscribe();
    return () => {
      void sb.removeChannel(channel);
    };
  }, [useRealtime, keyText, sourcesText, qc]);

  return useQuery({
    queryKey: key,
    queryFn: fn,
    refetchInterval: useRealtime ? Math.max(intervalMs, REALTIME_FALLBACK_POLL_MS) : intervalMs,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    ...rest,
  });
}
