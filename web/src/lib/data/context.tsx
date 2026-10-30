"use client";
// The DataApi screens use. Tests pass their own (e.g. createMockApi over a seed).
import { createContext, useContext, type ReactNode } from "react";
import type { DataApi, SubscribeSlots } from "./api";
import { getBrowserApi, getSlotSubscription } from "./client";

interface ApiContextValue {
  api: DataApi;
  subscribeSlots: SubscribeSlots;
}

const ApiContext = createContext<ApiContextValue | null>(null);

export function ApiProvider({ value, children }: { value?: ApiContextValue; children: ReactNode }) {
  return <ApiContext value={value ?? null}>{children}</ApiContext>;
}

export function useApi(): DataApi {
  return useContext(ApiContext)?.api ?? getBrowserApi();
}

export function useSubscribeSlots(): SubscribeSlots {
  return useContext(ApiContext)?.subscribeSlots ?? getSlotSubscription();
}
