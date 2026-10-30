"use client";
// The patient's approved record on the clinician's appointment view: facts
// approved by a clinician (any visit) and this visit's approved key points,
// plus this visit's drafts still waiting for review.
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { EmptyState, QueryView } from "@/components/states";
import { useApi } from "@/lib/data/context";
import { formatDate } from "@/lib/time";
import type { AppointmentWithRefs } from "@/types/db";
import { ReviewQueue, reviewCount, useReviewData } from "./review-queue";
import { answerText, factValueText } from "./values";

export function ClinicalRecord({ appointment, clinicianId }: { appointment: AppointmentWithRefs; clinicianId: string }) {
  const api = useApi();
  const tz = appointment.facility.timezone;
  const record = useQuery({
    queryKey: ["clinical-record", appointment.patient_id, appointment.id],
    queryFn: async () => {
      const [facts, keyPoints, fields, questions, runs, appointments] = await Promise.all([
        api.listClinicalFacts({ patientId: appointment.patient_id, statuses: ["approved"] }),
        api.listKeyPoints({ appointmentIds: [appointment.id], statuses: ["approved"] }),
        api.listClinicalFields(),
        api.listDecisionQuestions(),
        api.listConsultNoteRuns([appointment.id]),
        api.listAppointments({ patientId: appointment.patient_id, clinicianId, ascending: false }),
      ]);
      return { facts, keyPoints, fields, questions, run: runs[0] ?? null, appointments };
    },
  });
  const drafts = useReviewData(clinicianId, [appointment.id]);

  return (
    <div className="grid gap-4">
      <QueryView query={record}>
        {({ facts, keyPoints, fields, questions, run, appointments }) => (
          <>
            {run ? (
              <p className="text-sm text-muted-foreground" role="status">
                Documentation agent: {run.status === "done" ? `finished, drafted ${run.key_points_count} key points, ${run.facts_count} facts and ${run.open_items_count} open items` : run.status}
              </p>
            ) : null}
            <div className="grid gap-2">
              <h3 className="text-sm font-semibold">Approved facts</h3>
              {facts.length === 0 ? (
                <EmptyState title="No approved facts yet" />
              ) : (
                <ul className="grid gap-1 text-sm">
                  {facts.map((f) => {
                    const field = fields.find((x) => x.id === f.field_id);
                    const visit = appointments.find((x) => x.id === f.appointment_id);
                    return (
                      <li key={f.id} className="flex flex-wrap items-baseline gap-x-2">
                        <CheckCircle2 className="size-4 self-center text-success" aria-hidden="true" />
                        <span className="font-medium">{field?.label ?? f.field_id}:</span>
                        <span>{factValueText(f.value)}</span>
                        <span className="text-muted-foreground">
                          {visit ? `(visit ${formatDate(visit.scheduled_start, tz)})` : ""}
                          {f.value_edited ? " · corrected by clinician" : ""}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            {keyPoints.length ? (
              <div className="grid gap-2">
                <h3 className="text-sm font-semibold">Approved key points for this visit</h3>
                <ul className="grid gap-1 text-sm">
                  {keyPoints.map((k) => {
                    const q = questions.find((x) => x.id === k.question_id && x.version === k.question_version);
                    return (
                      <li key={k.id}>
                        <span className="text-muted-foreground">{q?.text ?? k.question_id}</span> <span className="font-medium">{answerText(k, q)}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </QueryView>
      {drafts.data && reviewCount(drafts.data) > 0 ? (
        <div className="grid gap-2">
          <h3 className="text-sm font-semibold">Waiting for your review</h3>
          <ReviewQueue data={drafts.data} showVisitLinks={false} />
        </div>
      ) : null}
    </div>
  );
}
