"use client";
// Data that changes while a screen is open (appointment status, consents,
// recording state). Part A polls every 5 seconds while the page is visible;
// Part B can switch this one hook to Supabase Realtime without touching screens.
import { useQuery, type QueryKey, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query";

export const LIVE_POLL_MS = 5000;

export function useLiveQuery<T>(
  key: QueryKey,
  fn: () => Promise<T>,
  options: { intervalMs?: number; enabled?: boolean } & Omit<UseQueryOptions<T>, "queryKey" | "queryFn" | "refetchInterval"> = {},
): UseQueryResult<T> {
  const { intervalMs = LIVE_POLL_MS, ...rest } = options;
  return useQuery({
    queryKey: key,
    queryFn: fn,
    refetchInterval: intervalMs,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    ...rest,
  });
}
