"use client";
// "Find care" choices shared between the patient home, map and booking pages.
// Kept in memory only: the reason text may be health information and the
// location is personal, so neither goes into the URL or browser storage.
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { LatLng } from "@/lib/geo";

export interface PatientLocation extends LatLng {
  label: string; // "your location" or the suburb / postcode
  source: "device" | "postcode";
}

interface FindCareState {
  reason: string;
  setReason: (v: string) => void;
  radiusKm: number;
  setRadiusKm: (v: number) => void;
  location: PatientLocation | null;
  setLocation: (v: PatientLocation | null) => void;
}

const FindCareContext = createContext<FindCareState | null>(null);

export const DEFAULT_RADIUS_KM = 10;

export function FindCareProvider({ children }: { children: ReactNode }) {
  const [reason, setReason] = useState("");
  const [radiusKm, setRadiusKm] = useState(DEFAULT_RADIUS_KM);
  const [location, setLocation] = useState<PatientLocation | null>(null);
  const value = useMemo(
    () => ({ reason, setReason, radiusKm, setRadiusKm, location, setLocation }),
    [reason, radiusKm, location],
  );
  return <FindCareContext value={value}>{children}</FindCareContext>;
}

export function useFindCare(): FindCareState {
  const v = useContext(FindCareContext);
  if (!v) throw new Error("useFindCare must be used inside FindCareProvider");
  return v;
}
