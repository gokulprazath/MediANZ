"use client";
import { useQuery } from "@tanstack/react-query";
import { useApi } from "@/lib/data/context";

export const ME_KEY = ["me"] as const;

export function useMe() {
  const api = useApi();
  return useQuery({ queryKey: ME_KEY, queryFn: () => api.whoami(), staleTime: 60_000 });
}
