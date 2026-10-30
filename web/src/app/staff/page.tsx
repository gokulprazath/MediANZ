"use client";
import Link from "next/link";
import { useState } from "react";
import { Field } from "@/components/form-field";
import { EmptyState, PageHeader, QueryView } from "@/components/states";
import { AppointmentStatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FrontDeskActions } from "@/features/staff/appointment-actions";
import { RequireClinic } from "@/features/staff/clinic-context";
import { clinicToday, dayRange } from "@/lib/clinic-day";
import { useApi } from "@/lib/data/context";
import { clinicianName, personName, visitTypeLabel } from "@/lib/format";
import { useLiveQuery } from "@/lib/hooks/use-live-query";
import { formatIsoDate, formatTime } from "@/lib/time";
import type { AppointmentWithRefs, Facility } from "@/types/db";

function FrontDesk({ clinic }: { clinic: Facility }) {
  const api = useApi();
  const tz = clinic.timezone;
  const [date, setDate] = useState(clinicToday(tz));
  const range = dayRange(date, tz);
  const query = useLiveQuery(["appointments", "front-desk", clinic.id, date], () =>
    api.listAppointments({ facilityId: clinic.id, from: range.from, to: range.to }),
  );

  return (
    <>
      <PageHeader
        title={`Front desk · ${clinic.name}`}
        description={`${formatIsoDate(date)}. Updates every few seconds.`}
        actions={
          <>
            <Field label="Day" className="w-44">
              <Input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
            </Field>
            <Button asChild className="self-end">
              <Link href="/staff/book">Book for a patient</Link>
            </Button>
          </>
        }
      />
      <QueryView query={query}>
        {(rows) => {
          if (!rows.length) return <EmptyState title="No appointments on this day" />;
          const byClinician = new Map<string, AppointmentWithRefs[]>();
          for (const a of rows) byClinician.set(a.clinician_id, [...(byClinician.get(a.clinician_id) ?? []), a]);
          return (
            <div className="grid gap-6">
              {[...byClinician.values()].map((list) => (
                <Card key={list[0].clinician_id}>
                  <CardHeader>
                    <CardTitle>
                      <h2 className="text-lg">{clinicianName(list[0].clinician)}</h2>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="divide-y">
                      {list.map((a) => (
                        <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                          <div className="grid gap-0.5">
                            <p className="font-medium">
                              <span className="tabular-nums">{formatTime(a.scheduled_start, tz)}</span> ·{" "}
                              {a.patient ? personName(a.patient) : "Patient"}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              {visitTypeLabel(a.visit_type)}
                              {a.patient?.phone ? ` · ${a.patient.phone}` : ""}
                              {a.checked_in_at ? ` · arrived ${formatTime(a.checked_in_at, tz)}` : ""}
                            </p>
                            <AppointmentStatusBadge status={a.status} className="justify-self-start" />
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <FrontDeskActions a={a} />
                            <Button asChild size="sm" variant="ghost">
                              <Link href={`/staff/visits/${a.id}`}>Details</Link>
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              ))}
            </div>
          );
        }}
      </QueryView>
    </>
  );
}

export default function FrontDeskPage() {
  return <RequireClinic>{(clinic) => <FrontDesk clinic={clinic} />}</RequireClinic>;
}
