"use client";
// One visit: who, when, arrival, wait and consult length, status history,
// front-desk actions, fees and insurance claims (6.4).
import Link from "next/link";
import { useParams } from "next/navigation";
import { EmptyState, PageHeader, QueryView } from "@/components/states";
import { AppointmentStatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { StatusHistory } from "@/features/appointments/status-history";
import { FeesForm } from "@/features/appointments/fees-form";
import { SectionCard } from "@/features/profile/sections";
import { FrontDeskActions } from "@/features/staff/appointment-actions";
import { ClaimsPanel } from "@/features/staff/claims-panel";
import { useApi } from "@/lib/data/context";
import { clinicianName, personName, visitTypeLabel } from "@/lib/format";
import { useLiveQuery } from "@/lib/hooks/use-live-query";
import { consultLength, waitMinutes } from "@/lib/reports";
import { formatDateTime, formatTime } from "@/lib/time";

const minutes = (m: number | null) => (m === null ? "—" : `${m} min`);

export default function VisitDetailPage() {
  const api = useApi();
  const { id } = useParams<{ id: string }>();
  const query = useLiveQuery(["appointment", id], () => api.getAppointment(id));

  return (
    <QueryView query={query}>
      {(a) => {
        if (!a) return <EmptyState title="Visit not found" />;
        const tz = a.facility.timezone;
        return (
          <>
            <PageHeader
              title={a.patient ? personName(a.patient) : "Visit"}
              description={`${formatDateTime(a.scheduled_start, tz)} · ${clinicianName(a.clinician)} · ${a.facility.name}`}
              actions={
                <Button asChild variant="outline">
                  <Link href="/staff/visits">Back to visits</Link>
                </Button>
              }
            />
            <div className="grid gap-6">
              <SectionCard id="visit" title="Visit">
                <div className="grid gap-4 md:grid-cols-2">
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">Status</dt>
                    <dd>
                      <AppointmentStatusBadge status={a.status} />
                    </dd>
                    <dt className="text-muted-foreground">Patient</dt>
                    <dd>{a.patient ? personName(a.patient) : "—"}</dd>
                    <dt className="text-muted-foreground">Phone</dt>
                    <dd>{a.patient?.phone ?? "—"}</dd>
                    <dt className="text-muted-foreground">Clinician</dt>
                    <dd>{clinicianName(a.clinician)}</dd>
                    <dt className="text-muted-foreground">Booked time</dt>
                    <dd>
                      {formatDateTime(a.scheduled_start, tz)} to {formatTime(a.scheduled_end, tz)}
                    </dd>
                    <dt className="text-muted-foreground">Visit type</dt>
                    <dd>{visitTypeLabel(a.visit_type)}</dd>
                    <dt className="text-muted-foreground">Reason</dt>
                    <dd>{a.reason ?? "—"}</dd>
                    <dt className="text-muted-foreground">Booked via</dt>
                    <dd className="capitalize">{a.booking_channel}</dd>
                  </dl>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">Arrived</dt>
                    <dd>{a.checked_in_at ? formatTime(a.checked_in_at, tz) : "—"}</dd>
                    <dt className="text-muted-foreground">Consult started</dt>
                    <dd>{a.consult_started_at ? formatTime(a.consult_started_at, tz) : "—"}</dd>
                    <dt className="text-muted-foreground">Consult ended</dt>
                    <dd>{a.consult_ended_at ? formatTime(a.consult_ended_at, tz) : "—"}</dd>
                    <dt className="text-muted-foreground">Wait</dt>
                    <dd>{minutes(waitMinutes(a))}</dd>
                    <dt className="text-muted-foreground">Consult length</dt>
                    <dd>{minutes(consultLength(a))}</dd>
                    {a.cancellation_reason ? (
                      <>
                        <dt className="text-muted-foreground">Cancellation reason</dt>
                        <dd>{a.cancellation_reason}</dd>
                      </>
                    ) : null}
                  </dl>
                </div>
                <div className="mt-4">
                  <FrontDeskActions a={a} />
                </div>
                <details className="mt-4">
                  <summary className="cursor-pointer text-sm font-medium">Status history</summary>
                  <div className="pt-2">
                    <StatusHistory appointmentId={a.id} timeZone={tz} />
                  </div>
                </details>
              </SectionCard>
              <SectionCard id="fees" title="Fees" description="Gap is the fee minus the Medicare rebate unless you change it.">
                <FeesForm key={a.updated_at} appointment={a} />
              </SectionCard>
              <SectionCard id="claims" title="Insurance claims">
                <ClaimsPanel appointmentId={a.id} timeZone={tz} defaultAmount={a.gap_amount} />
              </SectionCard>
            </div>
          </>
        );
      }}
    </QueryView>
  );
}
