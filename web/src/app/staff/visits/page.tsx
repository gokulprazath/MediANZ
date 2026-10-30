"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Field } from "@/components/form-field";
import { NativeSelect } from "@/components/native-select";
import { EmptyState, PageHeader, QueryView } from "@/components/states";
import { AppointmentStatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RequireClinic } from "@/features/staff/clinic-context";
import { clinicToday, dayRange } from "@/lib/clinic-day";
import { useApi } from "@/lib/data/context";
import { APPOINTMENT_STATUS_LABEL, clinicianName, formatMoney, personName } from "@/lib/format";
import { averageWait, consultLength, formatPercent, noShowRate, utilisation, waitMinutes } from "@/lib/reports";
import { addDays, diffDays, formatDate, formatTime } from "@/lib/time";
import { APPOINTMENT_STATUSES, type AppointmentStatus, type Facility } from "@/types/db";

function Visits({ clinic }: { clinic: Facility }) {
  const api = useApi();
  const tz = clinic.timezone;
  const today = clinicToday(tz);
  const [from, setFrom] = useState(addDays(today, -30));
  const [to, setTo] = useState(today);
  const [clinicianId, setClinicianId] = useState("");
  const [status, setStatus] = useState<AppointmentStatus | "">("");
  const days = Math.max(1, diffDays(to, from) + 1);
  const range = dayRange(from, tz, days);

  const query = useQuery({
    queryKey: ["appointments", "visits", clinic.id, from, to],
    queryFn: async () => {
      const [appointments, slots, clinicians] = await Promise.all([
        api.listAppointments({ facilityId: clinic.id, from: range.from, to: range.to, ascending: false }),
        api.listSlots({ facilityId: clinic.id, from: range.from, to: range.to }),
        api.listClinicians(),
      ]);
      return { appointments, slots, clinicians };
    },
    enabled: from <= to,
  });

  return (
    <>
      <PageHeader title="Visits, fees and claims" description={clinic.name} />
      <div className="mb-4 flex flex-wrap gap-4">
        <Field label="From" className="w-44">
          <Input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </Field>
        <Field label="To" className="w-44">
          <Input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
        </Field>
        <Field label="Clinician" className="w-56">
          <NativeSelect value={clinicianId} onChange={(e) => setClinicianId(e.target.value)}>
            <option value="">All</option>
            {query.data?.clinicians
              .filter((c) => query.data.appointments.some((a) => a.clinician_id === c.id))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {clinicianName(c)}
                </option>
              ))}
          </NativeSelect>
        </Field>
        <Field label="Status" className="w-48">
          <NativeSelect value={status} onChange={(e) => setStatus(e.target.value as AppointmentStatus | "")}>
            <option value="">All</option>
            {APPOINTMENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {APPOINTMENT_STATUS_LABEL[s]}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <QueryView query={query}>
        {({ appointments, slots, clinicians }) => {
          const rows = appointments.filter((a) => (!clinicianId || a.clinician_id === clinicianId) && (!status || a.status === status));
          const forReport = appointments.filter((a) => !clinicianId || a.clinician_id === clinicianId);
          const ns = noShowRate(forReport);
          const wait = averageWait(forReport);
          const util = utilisation(
            slots.filter((s) => !clinicianId || s.clinician_id === clinicianId),
            forReport,
          );
          return (
            <Tabs defaultValue="visits">
              <TabsList>
                <TabsTrigger value="visits">Visits ({rows.length})</TabsTrigger>
                <TabsTrigger value="reports">Reports</TabsTrigger>
              </TabsList>
              <TabsContent value="visits" className="pt-4">
                {rows.length === 0 ? (
                  <EmptyState title="No visits match these filters" />
                ) : (
                  <div className="overflow-x-auto rounded-lg border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>When</TableHead>
                          <TableHead>Patient</TableHead>
                          <TableHead>Clinician</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Arrived</TableHead>
                          <TableHead>Wait</TableHead>
                          <TableHead>Consult</TableHead>
                          <TableHead className="text-right">Fee</TableHead>
                          <TableHead>
                            <span className="sr-only">Actions</span>
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {rows.map((a) => {
                          const w = waitMinutes(a);
                          const c = consultLength(a);
                          return (
                            <TableRow key={a.id}>
                              <TableCell className="whitespace-nowrap">
                                {formatDate(a.scheduled_start, tz)} {formatTime(a.scheduled_start, tz)}
                              </TableCell>
                              <TableCell>{a.patient ? personName(a.patient) : "—"}</TableCell>
                              <TableCell>{clinicianName(a.clinician)}</TableCell>
                              <TableCell>
                                <AppointmentStatusBadge status={a.status} />
                              </TableCell>
                              <TableCell>{a.checked_in_at ? formatTime(a.checked_in_at, tz) : "—"}</TableCell>
                              <TableCell>{w !== null ? `${w} min` : "—"}</TableCell>
                              <TableCell>{c !== null ? `${c} min` : "—"}</TableCell>
                              <TableCell className="text-right tabular-nums">{formatMoney(a.fee_charged)}</TableCell>
                              <TableCell>
                                <Button asChild size="sm" variant="outline">
                                  <Link href={`/staff/visits/${a.id}`}>Open</Link>
                                </Button>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </TabsContent>
              <TabsContent value="reports" className="grid gap-4 pt-4">
                <div className="grid gap-4 sm:grid-cols-3">
                  <Card>
                    <CardHeader>
                      <CardTitle>
                        <h2 className="text-sm font-medium text-muted-foreground">No-show rate</h2>
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-3xl font-semibold tabular-nums">{formatPercent(ns.rate)}</p>
                      <p className="text-sm text-muted-foreground">
                        {ns.noShows} of {ns.due} due appointments
                      </p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardTitle>
                        <h2 className="text-sm font-medium text-muted-foreground">Average wait</h2>
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-3xl font-semibold tabular-nums">
                        {wait.minutes === null ? "—" : `${Math.round(wait.minutes)} min`}
                      </p>
                      <p className="text-sm text-muted-foreground">Check-in to consult start, {wait.visits} visits</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardTitle>
                        <h2 className="text-sm font-medium text-muted-foreground">Visits in range</h2>
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-3xl font-semibold tabular-nums">{forReport.filter((a) => a.status === "completed").length}</p>
                      <p className="text-sm text-muted-foreground">Completed, {days} day{days === 1 ? "" : "s"}</p>
                    </CardContent>
                  </Card>
                </div>
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <caption className="p-2 text-left text-sm text-muted-foreground">
                      Utilisation: booked slots out of offered (not blocked) slots in the date range.
                    </caption>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Clinician</TableHead>
                        <TableHead className="text-right">Offered</TableHead>
                        <TableHead className="text-right">Booked</TableHead>
                        <TableHead className="text-right">Utilisation</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {util.map((u) => {
                        const c = clinicians.find((x) => x.id === u.clinicianId);
                        return (
                          <TableRow key={u.clinicianId}>
                            <TableCell>{c ? clinicianName(c) : "—"}</TableCell>
                            <TableCell className="text-right tabular-nums">{u.offered}</TableCell>
                            <TableCell className="text-right tabular-nums">{u.booked}</TableCell>
                            <TableCell className="text-right tabular-nums">{formatPercent(u.rate)}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>
            </Tabs>
          );
        }}
      </QueryView>
    </>
  );
}

export default function VisitsPage() {
  return <RequireClinic>{(clinic) => <Visits clinic={clinic} />}</RequireClinic>;
}
