"use client";
// Appointment day (4.5): status polled every 5 s; consent and recording once
// the patient is checked in.
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useParams } from "next/navigation";
import { EmptyState, PageHeader, QueryView } from "@/components/states";
import { AppointmentStatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConsultPanel } from "@/features/consult/consult-panel";
import { useApi } from "@/lib/data/context";
import { clinicianName } from "@/lib/format";
import { useLiveQuery } from "@/lib/hooks/use-live-query";
import { useMe } from "@/lib/hooks/use-me";
import { friendlyError } from "@/lib/errors";
import { formatDateTime, formatTime } from "@/lib/time";

const WAITING = new Set(["booked", "confirmed"]);
const OPENS_MS = 30 * 60_000;
const CLOSES_MS = 15 * 60_000;

// patient_check_in: from 30 minutes before to 15 minutes after the start.
function SelfCheckIn({ appointmentId, start, timeZone }: { appointmentId: string; start: string; timeZone: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const s = Date.parse(start);
  if (now < s - OPENS_MS) {
    return <span className="text-sm text-muted-foreground">Self check-in opens at {formatTime(new Date(s - OPENS_MS), timeZone)}.</span>;
  }
  if (now > s + CLOSES_MS) return <span className="text-sm text-muted-foreground">Self check-in has closed; please see reception.</span>;
  return (
    <span>
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api.patientCheckIn(appointmentId);
            await qc.invalidateQueries({ queryKey: ["appointment", appointmentId] });
            toast.success("You're checked in");
          } catch (err) {
            toast.error(friendlyError(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        I&apos;ve arrived
      </Button>
    </span>
  );
}
const IN_CLINIC = new Set(["checked_in", "in_consultation"]);

export default function AppointmentDayPage() {
  const api = useApi();
  const me = useMe();
  const { id } = useParams<{ id: string }>();
  const query = useLiveQuery(["appointment", id], () => api.getAppointment(id), {
    realtime: [{ table: "appointments", filter: `id=eq.${id}` }],
  });

  return (
    <QueryView query={query}>
      {(a) => {
        if (!a) return <EmptyState title="Appointment not found" />;
        const tz = a.facility.timezone;
        return (
          <div className="mx-auto grid max-w-3xl gap-6">
            <PageHeader
              title="Appointment day"
              description={`${formatDateTime(a.scheduled_start, tz)} with ${clinicianName(a.clinician)} at ${a.facility.name}`}
            />
            <div className="flex items-center gap-2" aria-live="polite">
              <span className="text-sm text-muted-foreground">Status:</span>
              <AppointmentStatusBadge status={a.status} />
            </div>
            {WAITING.has(a.status) ? (
              <Alert>
                <AlertTitle>Please check in when you arrive</AlertTitle>
                <AlertDescription className="grid gap-3">
                  <span>
                    At {a.facility.name}, {a.facility.address_line1}, {a.facility.suburb}: tap &ldquo;I&apos;ve arrived&rdquo; or let
                    reception know you&apos;re here. This page updates by itself.
                  </span>
                  <SelfCheckIn appointmentId={a.id} start={a.scheduled_start} timeZone={tz} />
                </AlertDescription>
              </Alert>
            ) : null}
            {a.status === "checked_in" ? (
              <p role="status">You&apos;re checked in. {clinicianName(a.clinician)} will call you in soon.</p>
            ) : null}
            {a.status === "in_consultation" ? <p role="status">Your consultation is in progress.</p> : null}
            {IN_CLINIC.has(a.status) && me.data ? (
              <ConsultPanel
                appointment={a}
                party="patient"
                userId={me.data.userId}
                transcriptHref={(t) => `/patient/transcripts/${t}`}
              />
            ) : null}
            {a.status === "completed" ? (
              <Alert>
                <AlertTitle>Your visit is complete</AlertTitle>
                <AlertDescription className="flex flex-wrap gap-2 pt-2">
                  <Button asChild size="sm">
                    <Link href={`/patient/appointments/${a.id}/feedback`}>Rate this visit</Link>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link href="/patient/profile#recordings">My recordings and transcripts</Link>
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}
            {["cancelled", "no_show", "rescheduled"].includes(a.status) ? (
              <p>This appointment is no longer active.</p>
            ) : null}
            <div>
              <Button asChild variant="ghost">
                <Link href="/patient/appointments">Back to my appointments</Link>
              </Button>
            </div>
          </div>
        );
      }}
    </QueryView>
  );
}
