"use client";
// The clinic every staff screen is filtered by. Part A limitation: the
// backend's staff role can read all clinics, so this is a filter, not security.
// Only the clinic id is remembered in the browser (no personal or health data).
import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Field } from "@/components/form-field";
import { NativeSelect } from "@/components/native-select";
import { EmptyState, LoadingState } from "@/components/states";
import { useApi } from "@/lib/data/context";
import type { Facility } from "@/types/db";

const KEY = "medianz.staff.clinic";

interface ClinicState {
  clinicId: string | null;
  setClinicId: (id: string | null) => void;
  facilities: Facility[];
  clinic: Facility | null;
}

const ClinicContext = createContext<ClinicState | null>(null);

export function ClinicProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const facilities = useQuery({ queryKey: ["facilities"], queryFn: () => api.listFacilities(), staleTime: 5 * 60_000 });
  const [clinicId, setClinicIdState] = useState<string | null>(null);

  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after mount (storage is client-only)
      setClinicIdState(window.localStorage.getItem(KEY));
    } catch {
      // storage unavailable: pick each time
    }
  }, []);

  const setClinicId = (id: string | null) => {
    setClinicIdState(id);
    try {
      if (id) window.localStorage.setItem(KEY, id);
      else window.localStorage.removeItem(KEY);
    } catch {
      // ignore
    }
  };

  const list = facilities.data ?? [];
  const clinic = list.find((f) => f.id === clinicId) ?? null;
  return <ClinicContext value={{ clinicId, setClinicId, facilities: list, clinic }}>{children}</ClinicContext>;
}

export function useClinic(): ClinicState {
  const v = useContext(ClinicContext);
  if (!v) throw new Error("useClinic must be used inside ClinicProvider");
  return v;
}

export function ClinicPicker({ className }: { className?: string }) {
  const { clinicId, setClinicId, facilities } = useClinic();
  return (
    <Field label="Clinic" className={className}>
      <NativeSelect value={clinicId ?? ""} onChange={(e) => setClinicId(e.target.value || null)}>
        <option value="">Choose a clinic…</option>
        {facilities.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

/** Renders children only once a clinic is chosen. */
export function RequireClinic({ children }: { children: (clinic: Facility) => ReactNode }) {
  const { clinic, facilities, clinicId } = useClinic();
  if (!facilities.length) return <LoadingState />;
  if (!clinic) {
    return (
      <EmptyState title={clinicId ? "That clinic is no longer listed" : "Choose a clinic to start"}>
        <ClinicPicker className="mx-auto mt-3 w-72 text-left" />
      </EmptyState>
    );
  }
  return <>{children(clinic)}</>;
}
