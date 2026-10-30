"use client";
// Clinician review queue (Part B, B6): everything the agents drafted that needs
// a human. Urgent open items first, then patient questions, then each visit's
// draft key points and facts. Nothing reaches the patient's record until the
// clinician approves it (approve_* / edit_and_approve_* / reject_* RPCs).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bot, FileText, MessageSquareText } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Field } from "@/components/form-field";
import { NativeSelect } from "@/components/native-select";
import { EmptyState, QueryView } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useApi } from "@/lib/data/context";
import { friendlyError } from "@/lib/errors";
import { personName } from "@/lib/format";
import { useLiveQuery } from "@/lib/hooks/use-live-query";
import { formatDate, formatDateTime } from "@/lib/time";
import type { AppointmentWithRefs, ClinicalFact, ClinicalField, ConsultKeyPoint, DecisionQuestion, GpQuery, OpenItem, Uuid } from "@/types/db";
import { answerText, buildValue, editorFields, factValueText, initialRaw, optionLabel } from "./values";

export const REVIEW_KEY = ["review"] as const;

export interface ReviewData {
  keyPoints: ConsultKeyPoint[];
  facts: ClinicalFact[];
  openItems: OpenItem[];
  gpQueries: GpQuery[];
  questions: DecisionQuestion[];
  fields: ClinicalField[];
  appointments: AppointmentWithRefs[];
}

export function reviewCount(d: Pick<ReviewData, "keyPoints" | "facts" | "openItems" | "gpQueries">): number {
  return d.keyPoints.length + d.facts.length + d.openItems.length + d.gpQueries.length;
}

/** Drafts and open items the signed-in clinician (RLS) can review. */
export function useReviewData(clinicianId: Uuid, appointmentIds?: Uuid[]) {
  const api = useApi();
  return useLiveQuery(
    [...REVIEW_KEY, clinicianId, appointmentIds?.join(",") ?? "all"],
    async (): Promise<ReviewData> => {
      const scope = appointmentIds ? { appointmentIds } : {};
      const [keyPoints, facts, openItems, gpQueries, questions, fields, appointments] = await Promise.all([
        api.listKeyPoints({ ...scope, statuses: ["draft"] }),
        api.listClinicalFacts({ ...scope, statuses: ["draft"] }),
        api.listOpenItems({ ...scope, statuses: ["open"] }),
        api.listGpQueries({ ...scope, statuses: ["open"] }),
        api.listDecisionQuestions(),
        api.listClinicalFields(),
        api.listAppointments({ clinicianId, ascending: false }),
      ]);
      const mine = new Set(appointments.map((a) => a.id));
      const own = <T extends { appointment_id: Uuid }>(rows: T[]) => rows.filter((r) => mine.has(r.appointment_id));
      return { keyPoints: own(keyPoints), facts: own(facts), openItems: own(openItems), gpQueries: own(gpQueries), questions, fields, appointments };
    },
    { enabled: !!clinicianId, intervalMs: 15_000 },
  );
}

function useReviewAction() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (id: string, fn: () => Promise<void>, message: string) => {
    setBusy(id);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: REVIEW_KEY });
      await qc.invalidateQueries({ queryKey: ["clinical-record"] });
      toast.success(message);
      return true;
    } catch (err) {
      toast.error(friendlyError(err));
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

function Evidence({ appointmentId, segmentIds }: { appointmentId: Uuid; segmentIds: Uuid[] }) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ["segments", appointmentId],
    queryFn: () => api.listTranscriptSegments(appointmentId),
    enabled: open,
  });
  if (!segmentIds.length) return null;
  return (
    <div>
      <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <FileText aria-hidden="true" />
        {open ? "Hide" : "Show"} transcript evidence
      </Button>
      {open ? (
        <QueryView query={query}>
          {(segs) => {
            const rows = segs.filter((s) => segmentIds.includes(s.id));
            return rows.length ? (
              <ul className="mt-2 grid gap-1">
                {rows.map((s) => (
                  <li key={s.id} className="border-l-2 border-primary/50 pl-2 text-sm italic">
                    {s.speaker ? <span className="not-italic font-medium">{s.speaker}: </span> : null}
                    {s.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">The source text is no longer available.</p>
            );
          }}
        </QueryView>
      ) : null}
    </div>
  );
}

function Confidence({ value, threshold }: { value: number | null; threshold?: number }) {
  if (value === null) return null;
  const pct = Math.round(Number(value) * 100);
  const low = threshold !== undefined && Number(value) < Number(threshold);
  return (
    <Badge variant={low ? "destructive" : "outline"} title={threshold !== undefined ? `Threshold ${Math.round(Number(threshold) * 100)}%` : undefined}>
      {pct}% confident{low ? " · below threshold" : ""}
    </Badge>
  );
}

function KeyPointRow({ k, question }: { k: ConsultKeyPoint; question: DecisionQuestion | undefined }) {
  const api = useApi();
  const { busy, run } = useReviewAction();
  const [editing, setEditing] = useState(false);
  const [answer, setAnswer] = useState(k.answer);
  const [text, setText] = useState(k.answer_text ?? "");
  return (
    <li className="grid gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm text-muted-foreground">{question?.text ?? k.question_id}</p>
        <div className="flex flex-wrap gap-1">
          <Confidence value={k.probability} threshold={k.threshold} />
          {k.other_opinion_answer ? (
            <Badge variant="secondary">
              Second opinion: {optionLabel(question?.options.find((o) => o.value === k.other_opinion_answer) ?? { value: k.other_opinion_answer })}
            </Badge>
          ) : null}
        </div>
      </div>
      {editing ? (
        k.kind === "explain" ? (
          <Field label="Explanation">
            <Textarea rows={2} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
        ) : (
          <Field label="Answer" className="max-w-sm">
            <NativeSelect value={answer} onChange={(e) => setAnswer(e.target.value)}>
              {(question?.options ?? []).map((o) => (
                <option key={o.value} value={o.value}>
                  {optionLabel(o)}
                </option>
              ))}
            </NativeSelect>
          </Field>
        )
      ) : (
        <p className="font-medium">{answerText(k, question)}</p>
      )}
      <Evidence appointmentId={k.appointment_id} segmentIds={k.source_segment_ids} />
      <div className="flex flex-wrap gap-2">
        {editing ? (
          <>
            <Button
              size="sm"
              disabled={busy === k.id}
              onClick={async () => {
                const ok = await run(
                  k.id,
                  () => (k.kind === "explain" ? api.editAndApproveKeyPointText(k.id, text) : api.editAndApproveKeyPoint(k.id, answer)),
                  "Key point corrected and approved",
                );
                if (ok) setEditing(false);
              }}
            >
              Save and approve
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" disabled={busy === k.id} onClick={() => void run(k.id, () => api.approveKeyPoint(k.id), "Key point approved")}>
              Approve
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" disabled={busy === k.id} onClick={() => void run(k.id, () => api.rejectKeyPoint(k.id), "Key point rejected")}>
              Reject
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

function FactRow({ f, field }: { f: ClinicalFact; field: ClinicalField | undefined }) {
  const api = useApi();
  const { busy, run } = useReviewAction();
  const [editing, setEditing] = useState(false);
  const fields = editorFields(field);
  const [raw, setRaw] = useState(() => initialRaw(fields, f.value));
  const edited = buildValue(fields, raw);
  return (
    <li className="grid gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {field?.label ?? f.field_id}
          {f.negated ? " (stated as absent)" : ""}
          {f.experiencer !== "patient" ? ` · about ${f.experiencer}` : ""}
          {f.temporality !== "current" ? ` · ${f.temporality}` : ""}
        </p>
        <Confidence value={f.confidence} />
      </div>
      {editing ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {fields.map((ef) =>
            ef.kind === "enum" ? (
              <Field key={ef.key} label={ef.label} required={ef.required}>
                <NativeSelect value={raw[ef.key] ?? ""} onChange={(e) => setRaw({ ...raw, [ef.key]: e.target.value })}>
                  {(ef.options ?? []).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            ) : (
              <Field key={ef.key} label={<span className="capitalize">{ef.label}</span>} required={ef.required}>
                <Input
                  type={ef.kind === "text" ? "text" : "number"}
                  step={ef.kind === "integer" ? "1" : "any"}
                  value={raw[ef.key] ?? ""}
                  onChange={(e) => setRaw({ ...raw, [ef.key]: e.target.value })}
                />
              </Field>
            ),
          )}
        </div>
      ) : (
        <p className="font-medium">
          {factValueText(f.value)}
          {f.unit ?? field?.unit ? <span className="font-normal text-muted-foreground"> {f.unit ?? field?.unit}</span> : null}
        </p>
      )}
      <Evidence appointmentId={f.appointment_id} segmentIds={f.source_segment_ids} />
      <div className="flex flex-wrap gap-2">
        {editing ? (
          <>
            <Button
              size="sm"
              disabled={busy === f.id || edited === null}
              onClick={async () => {
                const ok = await run(f.id, () => api.editAndApproveFact(f.id, edited), "Fact corrected and approved");
                if (ok) setEditing(false);
              }}
            >
              Save and approve
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" disabled={busy === f.id} onClick={() => void run(f.id, () => api.approveFact(f.id), "Fact approved")}>
              Approve
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" disabled={busy === f.id} onClick={() => void run(f.id, () => api.rejectFact(f.id), "Fact rejected")}>
              Reject
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

function OpenItemRow({ o }: { o: OpenItem }) {
  const api = useApi();
  const { busy, run } = useReviewAction();
  const [resolution, setResolution] = useState("");
  return (
    <li className={o.kind === "urgent" ? "grid gap-2 rounded-lg border-2 border-destructive p-3" : "grid gap-2 rounded-lg border p-3"}>
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
        {o.kind === "urgent" ? <AlertTriangle className="size-4 text-destructive" aria-hidden="true" /> : null}
        {o.kind === "urgent" ? `Urgent (severity ${o.severity}/10)` : o.kind === "conflict" ? "Conflicting information" : "Missing information"}
      </p>
      <p>{o.description}</p>
      <Field label="How was this resolved?">
        <Input value={resolution} maxLength={2000} onChange={(e) => setResolution(e.target.value)} />
      </Field>
      <div>
        <Button
          size="sm"
          disabled={busy === o.id || !resolution.trim()}
          onClick={() => void run(o.id, () => api.resolveOpenItem(o.id, resolution.trim()), "Marked as resolved")}
        >
          Resolve
        </Button>
      </div>
    </li>
  );
}

function GpQueryRow({ q, appointment }: { q: GpQuery; appointment: AppointmentWithRefs | undefined }) {
  const api = useApi();
  const { busy, run } = useReviewAction();
  const [answer, setAnswer] = useState("");
  return (
    <li className="grid gap-2 rounded-lg border p-3">
      <p className="text-sm text-muted-foreground">
        {appointment?.patient ? personName(appointment.patient) : "Patient"} asked{" "}
        {appointment ? formatDateTime(q.created_at, appointment.facility.timezone) : ""} about the visit on{" "}
        {appointment ? formatDate(appointment.scheduled_start, appointment.facility.timezone) : "—"} (drafted by the AI assistant, approved by the patient)
      </p>
      <p className="font-medium">{q.question}</p>
      <Field label="Your answer" hint="The patient sees this in their assistant.">
        <Textarea rows={3} maxLength={4000} value={answer} onChange={(e) => setAnswer(e.target.value)} />
      </Field>
      <div>
        <Button size="sm" disabled={busy === q.id || !answer.trim()} onClick={() => void run(q.id, () => api.answerGpQuery(q.id, answer.trim()), "Answer sent")}>
          Send answer
        </Button>
      </div>
    </li>
  );
}

export function ReviewQueue({ data, showVisitLinks = true }: { data: ReviewData; showVisitLinks?: boolean }) {
  const byAppt = new Map(data.appointments.map((a) => [a.id, a]));
  const urgent = data.openItems.filter((o) => o.kind === "urgent").sort((a, b) => (b.severity ?? 0) - (a.severity ?? 0));
  const otherItems = data.openItems.filter((o) => o.kind !== "urgent");
  const visitIds = [...new Set([...data.keyPoints, ...data.facts, ...otherItems].map((x) => x.appointment_id))].sort((a, b) =>
    (byAppt.get(b)?.scheduled_start ?? "").localeCompare(byAppt.get(a)?.scheduled_start ?? ""),
  );
  if (reviewCount(data) === 0) {
    return <EmptyState title="Nothing to review">Drafts appear here after a patient approves a consultation transcript.</EmptyState>;
  }
  return (
    <div className="grid gap-6">
      {urgent.length ? (
        <section aria-labelledby="urgent-title" className="grid gap-2">
          <h2 id="urgent-title" className="flex items-center gap-2 text-lg font-semibold text-destructive">
            <AlertTriangle className="size-5" aria-hidden="true" />
            Urgent ({urgent.length})
          </h2>
          <ul className="grid gap-2">
            {urgent.map((o) => (
              <OpenItemRow key={o.id} o={o} />
            ))}
          </ul>
        </section>
      ) : null}
      {data.gpQueries.length ? (
        <section aria-labelledby="questions-title" className="grid gap-2">
          <h2 id="questions-title" className="flex items-center gap-2 text-lg font-semibold">
            <MessageSquareText className="size-5" aria-hidden="true" />
            Patient questions ({data.gpQueries.length})
          </h2>
          <ul className="grid gap-2">
            {data.gpQueries.map((q) => (
              <GpQueryRow key={q.id} q={q} appointment={byAppt.get(q.appointment_id)} />
            ))}
          </ul>
        </section>
      ) : null}
      {visitIds.map((id) => {
        const a = byAppt.get(id);
        const kps = data.keyPoints.filter((k) => k.appointment_id === id);
        const facts = data.facts.filter((f) => f.appointment_id === id);
        const items = otherItems.filter((o) => o.appointment_id === id);
        return (
          <Card key={id} role="region" aria-labelledby={`visit-${id}`}>
            <CardHeader>
              <CardTitle>
                <h2 id={`visit-${id}`} className="flex flex-wrap items-center gap-2 text-lg">
                  <Bot className="size-5" aria-hidden="true" />
                  {a?.patient ? personName(a.patient) : "Visit"}
                  {a ? <span className="font-normal text-muted-foreground">· {formatDate(a.scheduled_start, a.facility.timezone)}</span> : null}
                </h2>
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Drafted by the documentation agent from the approved transcript. Approve, correct or reject each one.
                {showVisitLinks && a ? (
                  <>
                    {" "}
                    <Link className="underline" href={`/clinician/appointments/${id}`}>
                      Open the visit
                    </Link>
                  </>
                ) : null}
              </p>
            </CardHeader>
            <CardContent className="grid gap-4">
              {items.length ? (
                <div className="grid gap-2">
                  <h3 className="text-sm font-semibold">Open items</h3>
                  <ul className="grid gap-2">
                    {items.map((o) => (
                      <OpenItemRow key={o.id} o={o} />
                    ))}
                  </ul>
                </div>
              ) : null}
              {kps.length ? (
                <div className="grid gap-2">
                  <h3 className="text-sm font-semibold">Key points ({kps.length})</h3>
                  <ul className="grid gap-2">
                    {kps.map((k) => (
                      <KeyPointRow key={k.id} k={k} question={data.questions.find((q) => q.id === k.question_id && q.version === k.question_version)} />
                    ))}
                  </ul>
                </div>
              ) : null}
              {facts.length ? (
                <div className="grid gap-2">
                  <h3 className="text-sm font-semibold">Facts for the record ({facts.length})</h3>
                  <ul className="grid gap-2">
                    {facts.map((f) => (
                      <FactRow key={f.id} f={f} field={data.fields.find((x) => x.id === f.field_id && x.version === f.field_version)} />
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
