"use client";
// Patient AI assistant (Part B, B5): a fleet of agents behind one chat. The
// agent service routes each message to one agent (records, insurance, fees),
// which may only use its own read-only tools with the patient's token. It can
// draft a question for the clinician, but nothing is sent until the patient
// approves it (/chat/confirm). The booking agent proposes a time; only the
// patient's Confirm books it (confirm_booking_proposal). The conversation is
// kept in memory above the patient pages (features/assistant/conversation): it
// survives moving between pages, ends on sign-out and is never stored in the
// browser. Each message sends the recent turns so follow-ups make sense.
import { useQueryClient } from "@tanstack/react-query";
import { Bot, CalendarCheck, MessageSquareText, Send, Sparkles, Trash2, User } from "lucide-react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { EmergencyBanner } from "@/components/emergency-banner";
import { EmptyState, PageHeader, QueryView } from "@/components/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { containsEmergencyWords } from "@/config/emergency";
import { AGENT_LABEL, SUGGESTIONS } from "@/features/assistant/agents";
import { type BookingOutcome, useConversation } from "@/features/assistant/conversation";
import { agentErrorMessage, agents } from "@/lib/agents/client";
import { readPendingAction } from "@/lib/agents/pending-action";
import type { BookingProposalCard } from "@/lib/agents/types";
import { useApi } from "@/lib/data/context";
import { clinicianName } from "@/lib/format";
import { useLiveQuery } from "@/lib/hooks/use-live-query";
import { useMe } from "@/lib/hooks/use-me";
import { formatCountdown, formatDate, formatDateTime } from "@/lib/time";
import { cn } from "@/lib/utils";

function BookingProposal({
  proposal,
  outcome,
  onOutcome,
}: {
  proposal: BookingProposalCard;
  outcome: BookingOutcome | undefined;
  onOutcome: (o: BookingOutcome) => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const done = outcome?.status === "booked" ? { booked: outcome.appointmentId } : outcome?.status === "declined" ? "declined" : null;
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const remaining = Date.parse(proposal.expires_at) - now;
  const decide = async (confirm: boolean) => {
    setBusy(true);
    try {
      if (confirm) {
        const appointmentId = await api.confirmBookingProposal(proposal.proposal_id);
        await qc.invalidateQueries({ queryKey: ["appointments"] });
        toast.success("Booked");
        onOutcome({ status: "booked", appointmentId });
      } else {
        await api.declineBookingProposal(proposal.proposal_id);
        onOutcome({ status: "declined" });
      }
    } catch (err) {
      toast.error(err instanceof Error && /no longer|expired|not available/i.test(err.message)
        ? "That time is no longer available. Ask the assistant for another."
        : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-2 rounded-md border bg-background p-3">
      <p className="flex items-center gap-2 font-medium">
        <CalendarCheck className="size-4" aria-hidden="true" />
        Book this appointment?
      </p>
      <p>{proposal.summary}</p>
      {done && done !== "declined" ? (
        <p role="status" className="text-success">
          Booked.{" "}
          <Link href={`/patient/appointments/${done.booked}/confirmed`} className="underline">
            See your booking
          </Link>
        </p>
      ) : done === "declined" ? (
        <p role="status" className="text-muted-foreground">
          Not booked.
        </p>
      ) : remaining <= 0 ? (
        <p role="status" className="text-muted-foreground">
          This offer has expired. Ask again for a new time.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void decide(true)} disabled={busy}>
              {busy ? "Booking…" : "Confirm booking"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void decide(false)} disabled={busy}>
              Not this one
            </Button>
          </div>
          <p className="text-xs text-muted-foreground" role="timer" aria-live="off">
            Nothing is booked until you confirm. This offer lasts {formatCountdown(remaining)}. For another time or clinic, ask
            again (for example &ldquo;book a GP on Friday afternoon&rdquo;) or use{" "}
            <Link href="/patient/find" className="underline">
              Find care
            </Link>
            .
          </p>
        </>
      )}
    </div>
  );
}

/** "To Dr Asha Rao, about your visit on Fri 16 Oct 2026": who the drafted question goes to. */
function QuestionRecipient({ appointmentId }: { appointmentId: string }) {
  const api = useApi();
  const appt = useQuery({ queryKey: ["appointment", appointmentId], queryFn: () => api.getAppointment(appointmentId) });
  if (!appt.data) return null;
  return (
    <p className="text-sm">
      To <strong>{clinicianName(appt.data.clinician)}</strong>, about your visit on{" "}
      {formatDate(appt.data.scheduled_start, appt.data.facility.timezone)} at {appt.data.facility.name}.
    </p>
  );
}

function MyQuestions({ patientId }: { patientId: string }) {
  const api = useApi();
  const query = useLiveQuery(["gp-queries", "mine", patientId], async () => {
    const [rows, appointments] = await Promise.all([api.listGpQueries(), api.listAppointments({ patientId, ascending: false })]);
    return { rows, appointments };
  }, { intervalMs: 15_000, realtime: [{ table: "gp_queries" }] });
  return (
    <Card aria-labelledby="my-questions">
      <CardHeader>
        <CardTitle>
          <h2 id="my-questions" className="flex items-center gap-2 text-lg">
            <MessageSquareText className="size-5" aria-hidden="true" />
            My questions to clinicians
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <QueryView query={query}>
          {({ rows, appointments }) =>
            rows.length === 0 ? (
              <EmptyState title="No questions yet">When the assistant can&apos;t answer, it can draft a question for your clinician.</EmptyState>
            ) : (
              <ul className="grid gap-3">
                {rows.map((q) => {
                  const a = appointments.find((x) => x.id === q.appointment_id);
                  return (
                    <li key={q.id} className="grid gap-1 rounded-lg border p-3 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-muted-foreground">
                          {a ? `${clinicianName(a.clinician)} · visit ${formatDate(a.scheduled_start, a.facility.timezone)}` : "Your clinician"}
                        </span>
                        <Badge variant={q.status === "answered" ? "default" : "secondary"}>{q.status === "answered" ? "Answered" : "Waiting for an answer"}</Badge>
                      </div>
                      <p className="font-medium">{q.question}</p>
                      {q.answer ? (
                        <p className="rounded-md bg-muted p-2 whitespace-pre-wrap">
                          <span className="font-medium">Answer: </span>
                          {q.answer}
                          {q.answered_at && a ? (
                            <span className="block text-xs text-muted-foreground">{formatDateTime(q.answered_at, a.facility.timezone)}</span>
                          ) : null}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )
          }
        </QueryView>
      </CardContent>
    </Card>
  );
}

export default function AssistantPage() {
  const me = useMe();
  const qc = useQueryClient();
  const { turns, busy, ask: send, update, clear } = useConversation();
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLOListElement>(null);
  const patientId = me.data?.patient?.id ?? "";

  useEffect(() => {
    logRef.current?.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [turns.length]);

  const ask = async (text: string) => {
    if (!text.trim() || busy) return;
    setDraft("");
    await send(text);
  };

  const decide = async (turnId: number, send: boolean) => {
    const turn = turns.find((t) => t.id === turnId);
    if (!turn || turn.from !== "agent" || !turn.pending) return;
    if (send) {
      try {
        await agents.confirm(turn.pending.action);
        await qc.invalidateQueries({ queryKey: ["gp-queries"] });
        toast.success("Question sent to your clinician");
      } catch (err) {
        toast.error(agentErrorMessage(err));
        return;
      }
    }
    update(turnId, { decided: send ? "sent" : "declined" });
  };

  const emergency = containsEmergencyWords(draft) || turns.some((t) => t.from === "patient" && containsEmergencyWords(t.text));

  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <PageHeader
        title="AI assistant"
        description="A team of AI agents that answer from your approved record, your insurance plan and clinic fees, and can book an appointment for you to confirm. It doesn't diagnose or give medical advice."
        actions={
          turns.length ? (
            <Button variant="outline" onClick={clear}>
              <Trash2 aria-hidden="true" />
              Clear conversation
            </Button>
          ) : null
        }
      />
      {emergency ? <EmergencyBanner /> : null}
      <Alert>
        <Sparkles aria-hidden="true" />
        <AlertTitle>AI assistant, not a clinician</AlertTitle>
        <AlertDescription>
          Answers come only from facts your clinician approved. If it can&apos;t answer, it drafts a question for your clinician and
          sends it only if you approve. Ask it to book and it offers a time; nothing is booked until you confirm. This
          conversation stays while you move around the app and is cleared when you sign out; it isn&apos;t saved. For
          emergencies call 000. To compare clinics on a map, use{" "}
          <Link href="/patient/find" className="underline">
            Find care
          </Link>
          .
        </AlertDescription>
      </Alert>

      <Card>
        <CardContent className="grid gap-4 pt-6">
          {turns.length === 0 ? (
            <div className="grid gap-2">
              <p className="text-sm text-muted-foreground">Try asking:</p>
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <Button key={s} variant="outline" size="sm" onClick={() => void ask(s)} disabled={busy}>
                    {s}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <ol ref={logRef} className="grid gap-4" aria-label="Conversation" aria-live="polite">
              {turns.map((t) => (
                <li key={t.id} className={cn("flex gap-3", t.from === "patient" && "flex-row-reverse")}>
                  <span
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-full",
                      t.from === "patient" ? "bg-primary text-primary-foreground" : "bg-accent text-accent-foreground",
                    )}
                    aria-hidden="true"
                  >
                    {t.from === "patient" ? <User className="size-4" /> : <Bot className="size-4" />}
                  </span>
                  <div className={cn("grid max-w-[85%] gap-2 rounded-lg p-3 text-sm", t.from === "patient" ? "bg-primary/10" : t.from === "error" ? "bg-danger-soft text-destructive" : "bg-muted")}>
                    <span className="sr-only">{t.from === "patient" ? "You said:" : t.from === "error" ? "Error:" : `${AGENT_LABEL[t.agent].name} said:`}</span>
                    {t.from === "agent" ? (
                      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-hidden="true">
                        <Badge variant="outline">{AGENT_LABEL[t.agent].name}</Badge>
                        {AGENT_LABEL[t.agent].does}
                      </span>
                    ) : null}
                    <p className="whitespace-pre-wrap">{t.text}</p>
                    {t.from === "agent" && t.proposal ? (
                      <BookingProposal proposal={t.proposal} outcome={t.booking} onOutcome={(booking) => update(t.id, { booking })} />
                    ) : null}
                    {t.from === "agent" && t.pending ? (
                      <div className="grid gap-2 rounded-md border bg-background p-3">
                        <p className="font-medium">Send this question to your clinician?</p>
                        {t.pending.appointmentId ? <QuestionRecipient appointmentId={t.pending.appointmentId} /> : null}
                        <blockquote className="border-l-2 pl-3 italic">
                          {readPendingAction(t.pending.action)?.question ?? "The question the assistant drafted"}
                        </blockquote>
                        {t.decided === "sent" ? (
                          <p role="status" className="text-success">
                            Sent. The answer will appear under &ldquo;My questions&rdquo;.
                          </p>
                        ) : t.decided === "declined" ? (
                          <p role="status" className="text-muted-foreground">
                            Not sent.
                          </p>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" onClick={() => void decide(t.id, true)}>
                              Approve and send
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => void decide(t.id, false)}>
                              Don&apos;t send
                            </Button>
                          </div>
                        )}
                        <p className="text-xs text-muted-foreground">
                          To change the wording, ask again in your own words; the assistant can only send the exact question shown.
                        </p>
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
              {busy ? (
                <li className="flex gap-3" role="status">
                  <span className="flex size-8 items-center justify-center rounded-full bg-accent" aria-hidden="true">
                    <Bot className="size-4" />
                  </span>
                  <span className="self-center text-sm text-muted-foreground">The agents are working on it…</span>
                </li>
              ) : null}
            </ol>
          )}
          <form
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(draft);
            }}
          >
            <Label htmlFor="assistant-input">Your question</Label>
            <Textarea
              id="assistant-input"
              rows={2}
              maxLength={2000}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void ask(draft);
                }
              }}
              placeholder="For example: what did my doctor say about my iron levels?"
            />
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">Enter to send, Shift+Enter for a new line. Don&apos;t include other people&apos;s details.</p>
              <Button type="submit" disabled={busy || !draft.trim()}>
                <Send aria-hidden="true" />
                Send
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {patientId ? <MyQuestions patientId={patientId} /> : null}
    </div>
  );
}
