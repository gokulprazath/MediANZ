"use client";
// Clinician appointment view (5.2): patient summary, past visits with this
// clinician, vitals, approved transcripts and the consult controls.
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { Field } from "@/components/form-field";
import { EmptyState, PageHeader, QueryView } from "@/components/states";
import { AppointmentStatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FeesForm } from "@/features/appointments/fees-form";
import { ConsultPanel } from "@/features/consult/consult-panel";
import { formatOffset, speakerTurns } from "@/features/consult/transcript";
import { ClinicalRecord } from "@/features/review/clinical-record";
import { VitalsForm } from "@/features/consult/vitals-form";
import { SectionCard } from "@/features/profile/sections";
import { useStatusChange } from "@/features/staff/appointment-actions";
import { useApi } from "@/lib/data/context";
import { friendlyError } from "@/lib/errors";
import { formatMoney, personName, SEX_LABEL, visitTypeLabel } from "@/lib/format";
import { useLiveQuery } from "@/lib/hooks/use-live-query";
import { useMe } from "@/lib/hooks/use-me";
import { ageOn, formatDate, formatDateTime, formatIsoDate, formatTime, localDate } from "@/lib/time";
import { notesSchema } from "@/lib/validation";
import type { AppointmentWithRefs, VisitVitals, VisitVitalsLatest } from "@/types/db";

function NotesForm({ a }: { a: AppointmentWithRefs }) {
  const api = useApi();
  const qc = useQueryClient();
  const form = useForm({ resolver: zodResolver(notesSchema), defaultValues: { clinical_notes: a.clinical_notes ?? "" } });
  const { errors, isSubmitting, isDirty } = form.formState;
  return (
    <form
      noValidate
      className="grid gap-3"
      onSubmit={form.handleSubmit(async (v) => {
        try {
          await api.updateAppointment(a.id, v);
          await qc.invalidateQueries({ queryKey: ["appointment", a.id] });
          form.reset(form.getValues());
          toast.success("Notes saved");
        } catch (err) {
          toast.error(friendlyError(err));
        }
      })}
    >
      <Field label="Clinical notes" error={errors.clinical_notes?.message} hint="Saved on this visit's record.">
        <Textarea rows={6} maxLength={10000} {...form.register("clinical_notes")} />
      </Field>
      <div>
        <Button type="submit" disabled={isSubmitting || !isDirty}>
          {isSubmitting ? "Saving…" : "Save notes"}
        </Button>
      </div>
    </form>
  );
}

function VitalsTable({ rows, timeZone }: { rows: (VisitVitals | VisitVitalsLatest)[]; timeZone: string }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">No vitals recorded.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-1 pr-3 font-medium">Recorded</th>
            <th className="py-1 pr-3 font-medium">Temp (°C)</th>
            <th className="py-1 pr-3 font-medium">SpO2 (%)</th>
            <th className="py-1 pr-3 font-medium">BP (mmHg)</th>
            <th className="py-1 pr-3 font-medium">Height (cm)</th>
            <th className="py-1 pr-3 font-medium">Weight (kg)</th>
            <th className="py-1 pr-3 font-medium">BMI</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((v, i) => {
            const at = "recorded_at" in v ? v.recorded_at : (v.last_recorded_at ?? v.visit_start);
            return (
              <tr key={i} className="border-t">
                <td className="py-1 pr-3">{formatDateTime(at, timeZone)}</td>
                <td className="py-1 pr-3">{v.temperature_c ?? "—"}</td>
                <td className="py-1 pr-3">{v.spo2_percent ?? "—"}</td>
                <td className="py-1 pr-3">{v.bp_systolic !== null ? `${v.bp_systolic}/${v.bp_diastolic}` : "—"}</td>
                <td className="py-1 pr-3">{v.height_cm ?? "—"}</td>
                <td className="py-1 pr-3">{v.weight_kg ?? "—"}</td>
                <td className="py-1 pr-3">{v.bmi ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ConsultView({ a, userId }: { a: AppointmentWithRefs; userId: string }) {
  const api = useApi();
  const change = useStatusChange();
  const [busy, setBusy] = useState(false);
  const [openedAt] = useState(() => new Date());
  const tz = a.facility.timezone;
  const patientId = a.patient_id;

  const details = useQuery({
    queryKey: ["clinician-view", a.id],
    queryFn: async () => {
      const [patient, past, latest] = await Promise.all([
        api.getPatient(patientId),
        api.listAppointments({ patientId, clinicianId: a.clinician_id, ascending: false }),
        api.listVitalsLatest(patientId),
      ]);
      const visits = past.filter((x) => x.id !== a.id && x.scheduled_start < a.scheduled_start);
      const transcripts = await api.listTranscripts([a.id, ...visits.map((x) => x.id)]);
      return { patient, visits, latest, transcripts };
    },
  });
  const vitals = useQuery({ queryKey: ["vitals", a.id], queryFn: () => api.listVitals(a.id) });

  const run = async (status: "in_consultation" | "completed" | "no_show", message: string) => {
    setBusy(true);
    await change(a, status, message).catch(() => undefined);
    setBusy(false);
  };

  const unattended = (a.status === "booked" || a.status === "confirmed") && new Date(a.scheduled_start) < openedAt;
  const inClinic = a.status === "checked_in" || a.status === "in_consultation";
  const canRecordVitals = inClinic || a.status === "completed";

  return (
    <div className="grid gap-6">
      <SectionCard id="consult" title="Consultation">
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-3" aria-live="polite">
            <AppointmentStatusBadge status={a.status} />
            {a.checked_in_at ? <span className="text-sm">Arrived {formatTime(a.checked_in_at, tz)}</span> : null}
            {a.consult_started_at ? <span className="text-sm">Started {formatTime(a.consult_started_at, tz)}</span> : null}
            {a.consult_ended_at ? <span className="text-sm">Ended {formatTime(a.consult_ended_at, tz)}</span> : null}
          </div>
          {a.status === "booked" || a.status === "confirmed" ? (
            <p className="text-sm text-muted-foreground">The patient hasn&apos;t checked in at reception yet.</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {a.status === "checked_in" ? (
              <Button disabled={busy} onClick={() => run("in_consultation", "Consultation started")}>
                Start consultation
              </Button>
            ) : null}
            {a.status === "in_consultation" ? (
              <ConfirmAction
                trigger="Complete consultation"
                destructive={false}
                title="Complete this consultation?"
                description="Stop any recording first. The visit is then closed and the patient can leave feedback."
                confirmLabel="Complete"
                onConfirm={() => change(a, "completed", "Consultation completed")}
              />
            ) : null}
            {unattended ? (
              <ConfirmAction
                trigger="Mark no-show"
                variant="outline"
                title="Mark as did not attend?"
                description="Use this only when the patient didn't arrive. It can't be undone."
                confirmLabel="Mark no-show"
                onConfirm={() => change(a, "no_show", "Marked as did not attend")}
              />
            ) : null}
          </div>
        </div>
      </SectionCard>

      {inClinic || a.status === "booked" || a.status === "confirmed" ? (
        <ConsultPanel appointment={a} party="clinician" userId={userId} />
      ) : null}

      <QueryView query={details}>
        {({ patient, visits, latest, transcripts }) => {
          const latestRow = [...latest].sort((x, y) => (y.last_recorded_at ?? y.visit_start).localeCompare(x.last_recorded_at ?? x.visit_start))[0];
          return (
            <>
              <SectionCard id="patient" title="Patient">
                {!patient ? (
                  <p className="text-sm text-muted-foreground">Patient details aren&apos;t available.</p>
                ) : (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr_auto_1fr]">
                    <dt className="text-muted-foreground">Name</dt>
                    <dd>{personName(patient)}</dd>
                    <dt className="text-muted-foreground">Age</dt>
                    <dd>
                      {ageOn(patient.date_of_birth, localDate(openedAt, tz))} (born {formatIsoDate(patient.date_of_birth)})
                    </dd>
                    <dt className="text-muted-foreground">Sex</dt>
                    <dd>{patient.sex ? SEX_LABEL[patient.sex] : "Not provided"}</dd>
                    <dt className="text-muted-foreground">Phone</dt>
                    <dd>{patient.phone ?? "—"}</dd>
                    <dt className="text-muted-foreground">Email</dt>
                    <dd className="break-all">{patient.email ?? "—"}</dd>
                    <dt className="text-muted-foreground">Emergency contact</dt>
                    <dd>
                      {patient.emergency_contact_name
                        ? `${patient.emergency_contact_name}${patient.emergency_contact_relationship ? ` (${patient.emergency_contact_relationship})` : ""}, ${patient.emergency_contact_phone ?? "no phone"}`
                        : "—"}
                    </dd>
                    <dt className="text-muted-foreground">Reason</dt>
                    <dd>{a.reason ?? "—"}</dd>
                    <dt className="text-muted-foreground">Visit type</dt>
                    <dd>{visitTypeLabel(a.visit_type)}</dd>
                  </dl>
                )}
              </SectionCard>

              <SectionCard
                id="record"
                title="Clinical record (AI drafted, clinician approved)"
                description="The documentation agent drafts facts and key points from approved transcripts. Only what a clinician approves is part of the record."
              >
                <ClinicalRecord appointment={a} clinicianId={a.clinician_id} />
              </SectionCard>

              <SectionCard id="vitals" title="Vitals">
                <div className="grid gap-4">
                  <div>
                    <h3 className="mb-1 text-sm font-semibold">Latest recorded</h3>
                    <VitalsTable rows={latestRow ? [latestRow] : []} timeZone={tz} />
                  </div>
                  <div>
                    <h3 className="mb-1 text-sm font-semibold">This visit</h3>
                    <QueryView query={vitals}>{(rows) => <VitalsTable rows={rows} timeZone={tz} />}</QueryView>
                  </div>
                  {canRecordVitals ? (
                    <VitalsForm appointmentId={a.id} patientId={patientId} />
                  ) : (
                    <p className="text-sm text-muted-foreground">Vitals can be recorded once the patient has checked in.</p>
                  )}
                </div>
              </SectionCard>

              <SectionCard id="notes" title="Notes and fees">
                <div className="grid gap-6">
                  <NotesForm key={`notes-${a.id}`} a={a} />
                  <div>
                    <h3 className="mb-2 text-sm font-semibold">Fees</h3>
                    <FeesForm key={a.updated_at} appointment={a} />
                  </div>
                </div>
              </SectionCard>

              <SectionCard id="history" title="Past visits with you">
                {visits.length === 0 ? (
                  <EmptyState title="No earlier visits with you" />
                ) : (
                  <ul className="grid gap-3">
                    {visits.map((v) => (
                      <li key={v.id} className="grid gap-1 rounded-lg border p-3 text-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <Link className="font-medium underline" href={`/clinician/appointments/${v.id}`}>
                            {formatDate(v.scheduled_start, v.facility.timezone)}
                          </Link>
                          <AppointmentStatusBadge status={v.status} />
                        </div>
                        <p>
                          <span className="text-muted-foreground">Reason:</span> {v.reason ?? "—"}
                        </p>
                        <p className="whitespace-pre-wrap">
                          <span className="text-muted-foreground">Notes:</span> {v.clinical_notes ?? "—"}
                        </p>
                        <p className="tabular-nums">
                          <span className="text-muted-foreground">Fees:</span> {formatMoney(v.fee_charged)} charged,{" "}
                          {formatMoney(v.medicare_rebate)} rebate, {formatMoney(v.gap_amount)} gap
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>

              <SectionCard id="transcripts" title="Approved transcripts" description="You see a transcript only after the patient approves it.">
                {transcripts.length === 0 ? (
                  <EmptyState title="No approved transcripts" />
                ) : (
                  <ul className="grid gap-3">
                    {transcripts.map((t) => (
                      <li key={t.id}>
                        <details className="rounded-lg border p-3">
                          <summary className="cursor-pointer font-medium">
                            Transcript, {formatDateTime(t.created_at, tz)}
                          </summary>
                          <ol className="mt-3 grid gap-3 text-sm">
                            {speakerTurns(t).map((turn, i) => (
                              <li key={i}>
                                <p className="font-semibold">
                                  {turn.speaker}
                                  {turn.startSec !== null ? (
                                    <span className="ml-2 font-normal text-muted-foreground tabular-nums">{formatOffset(turn.startSec)}</span>
                                  ) : null}
                                </p>
                                <p className="whitespace-pre-wrap">{turn.text}</p>
                              </li>
                            ))}
                          </ol>
                        </details>
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>
            </>
          );
        }}
      </QueryView>
    </div>
  );
}

export default function ClinicianAppointmentPage() {
  const api = useApi();
  const me = useMe();
  const { id } = useParams<{ id: string }>();
  const query = useLiveQuery(["appointment", id], () => api.getAppointment(id));

  return (
    <QueryView query={query}>
      {(a) =>
        !a || !me.data ? (
          <EmptyState title="Appointment not found" />
        ) : (
          <>
            <PageHeader
              title={a.patient ? personName(a.patient) : "Appointment"}
              description={`${formatDateTime(a.scheduled_start, a.facility.timezone)} · ${a.facility.name}`}
              actions={
                <Button asChild variant="outline">
                  <Link href="/clinician">Back to calendar</Link>
                </Button>
              }
            />
            <ConsultView a={a} userId={me.data.userId} />
          </>
        )
      }
    </QueryView>
  );
}
