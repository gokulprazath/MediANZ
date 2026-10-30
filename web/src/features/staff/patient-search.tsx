"use client";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Field } from "@/components/form-field";
import { LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApi } from "@/lib/data/context";
import { personName } from "@/lib/format";
import { formatIsoDate } from "@/lib/time";
import type { Patient } from "@/types/db";

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function PatientSearch({ onSelect }: { onSelect: (p: Patient) => void }) {
  const api = useApi();
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim());
  const results = useQuery({
    queryKey: ["patient-search", term],
    queryFn: () => api.searchPatients(term),
    enabled: term.length >= 2,
  });
  return (
    <div className="grid gap-3">
      <Field label="Find a patient" hint="Name, email, phone, Medicare number or date of birth (YYYY-MM-DD).">
        <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      </Field>
      {term.length >= 2 && results.isPending ? <LoadingState label="Searching…" /> : null}
      {results.data ? (
        results.data.length ? (
          <ul className="grid gap-1" aria-label="Matching patients">
            {results.data.map((p) => (
              <li key={p.id}>
                <Button variant="outline" className="h-auto w-full justify-start py-2 text-left" onClick={() => onSelect(p)}>
                  <Search aria-hidden="true" />
                  <span>
                    <span className="font-medium">{personName(p)}</span>
                    <span className="block text-sm text-muted-foreground">
                      Born {formatIsoDate(p.date_of_birth)}
                      {p.phone ? ` · ${p.phone}` : ""}
                    </span>
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No patients found.</p>
        )
      ) : null}
    </div>
  );
}
