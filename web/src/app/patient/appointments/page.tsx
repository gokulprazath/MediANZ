"use client";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { Field } from "@/components/form-field";
import { EmptyState, PageHeader, QueryView } from "@/components/states";
import { AppointmentStatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { StatusHistory } from "@/features/appointments/status-history";
import { useApi } from "@/lib/data/context";
import { friendlyError } from "@/lib/errors";
import { clinicianName, visitTypeLabel } from "@/lib/format";
import { useLiveQuery } from "@/lib/hooks/use-live-query";
import { useMe } from "@/lib/hooks/use-me";
import { formatDateTime, localDate } from "@/lib/time";
import type { AppointmentWithRefs } from "@/types/db";

const OPEN = new Set(["booked", "confirmed"]);
const DAY = new Set(["booked", "confirmed", "checked_in", "in_consultation"]);

function CancelButton({ appointment }: { appointment: AppointmentWithRefs }) {
  const api = useApi();
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  return (
    <ConfirmAction
      trigger="Cancel"
      size="sm"
      variant="outline"
      title="Cancel this appointment?"
      description={`${formatDateTime(appointment.scheduled_start, appointment.facility.timezone)} with ${clinicianName(appointment.clinician)}. The time will be offered to other patients.`}
      confirmLabel="Cancel appointment"
      onConfirm={async () => {
        try {
          await api.cancelAppointment(appointment.id, reason.trim() || null);
          await qc.invalidateQueries({ queryKey: ["appointments"] });
          toast.success("Appointment cancelled");
        } catch (err) {
          toast.error(friendlyError(err));
          throw err;
        }
      }}
    >
      <Field label="Reason (optional)" hint="Shared with the clinic.">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} rows={2} />
      </Field>
    </ConfirmAction>
  );
}

function AppointmentRow({ a, now }: { a: AppointmentWithRefs; now: Date }) {
  const tz = a.facility.timezone;
  const future = new Date(a.scheduled_start) > now;
  const today = localDate(a.scheduled_start, tz) === localDate(now, tz);
  const recentCompleted =
    a.status === "completed" && a.consult_ended_at && now.getTime() - Date.parse(a.consult_ended_at) < 30 * 86_400_000;
  return (
    <Card>
      <CardContent className="grid gap-3 pt-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="font-semibold">{formatDateTime(a.scheduled_start, tz)}</h3>
            <p>
              {clinicianName(a.clinician)} · {a.facility.name}, {a.facility.suburb}
            </p>
            <p className="text-sm text-muted-foreground">
              {visitTypeLabel(a.visit_type)}
              {a.reason ? ` · ${a.reason}` : ""}
            </p>
          </div>
          <AppointmentStatusBadge status={a.status} />
        </div>
        <div className="flex flex-wrap gap-2">
          {today && DAY.has(a.status) ? (
            <Button asChild size="sm">
              <Link href={`/patient/appointments/${a.id}/live`}>Appointment day</Link>
            </Button>
          ) : null}
          {future && OPEN.has(a.status) ? (
            <>
              <Button asChild size="sm" variant="outline">
                <Link href={`/patient/book/${a.clinician_id}?facility=${a.facility_id}&reschedule=${a.id}`}>Reschedule</Link>
              </Button>
              <CancelButton appointment={a} />
              <Button asChild size="sm" variant="ghost">
                <a href={`/api/appointments/${a.id}/ics`} download>
                  Add to calendar
                </a>
              </Button>
            </>
          ) : null}
          {recentCompleted ? (
            <Button asChild size="sm" variant="outline">
              <Link href={`/patient/appointments/${a.id}/feedback`}>Rate this visit</Link>
            </Button>
          ) : null}
        </div>
        <details>
          <summary className="cursor-pointer text-sm font-medium">Status history</summary>
          <div className="pt-2">
            <StatusHistory appointmentId={a.id} timeZone={tz} />
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

export default function MyAppointmentsPage() {
  const api = useApi();
  const me = useMe();
  const patientId = me.data?.patient?.id ?? "";
  const query = useLiveQuery(["appointments", "mine", patientId], () => api.listAppointments({ patientId }), {
    enabled: !!patientId,
    intervalMs: 30_000,
  });
  const now = new Date();

  return (
    <>
      <PageHeader
        title="My appointments"
        actions={
          <Button asChild>
            <Link href="/patient/find">Book an appointment</Link>
          </Button>
        }
      />
      <QueryView query={query}>
        {(rows) => {
          const upcoming = rows.filter((a) => new Date(a.scheduled_end) > now && DAY.has(a.status));
          const past = rows.filter((a) => !upcoming.includes(a)).reverse();
          return (
            <Tabs defaultValue="upcoming">
              <TabsList>
                <TabsTrigger value="upcoming">Upcoming ({upcoming.length})</TabsTrigger>
                <TabsTrigger value="past">Past and cancelled ({past.length})</TabsTrigger>
              </TabsList>
              <TabsContent value="upcoming" className="grid gap-3 pt-4">
                {upcoming.length ? (
                  upcoming.map((a) => <AppointmentRow key={a.id} a={a} now={now} />)
                ) : (
                  <EmptyState title="No upcoming appointments" />
                )}
              </TabsContent>
              <TabsContent value="past" className="grid gap-3 pt-4">
                {past.length ? past.map((a) => <AppointmentRow key={a.id} a={a} now={now} />) : <EmptyState title="No past appointments" />}
              </TabsContent>
            </Tabs>
          );
        }}
      </QueryView>
    </>
  );
}
