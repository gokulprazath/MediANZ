"use client";
// Patient AI assistant (Part B, B5): a fleet of agents behind one chat. The
// agent service routes each message to one agent (records, insurance, fees),
// which may only use its own read-only tools with the patient's token. It can
// draft a question for the clinician, but nothing is sent until the patient
// approves it (/chat/confirm). The conversation lives in this page's memory
// only and is never stored in the browser.
import { useQueryClient } from "@tanstack/react-query";
import { Bot, MessageSquareText, Send, Sparkles, Trash2, User } from "lucide-react";
import Link from "next/link";
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
import { agentErrorMessage, agents } from "@/lib/agents/client";
import { readPendingAction } from "@/lib/agents/pending-action";
import type { AgentRole } from "@/lib/agents/types";
import { useApi } from "@/lib/data/context";
import { clinicianName } from "@/lib/format";
import { useLiveQuery } from "@/lib/hooks/use-live-query";
import { useMe } from "@/lib/hooks/use-me";
import { formatDate, formatDateTime } from "@/lib/time";
import { cn } from "@/lib/utils";

type Turn =
  | { id: number; from: "patient"; text: string }
  | { id: number; from: "agent"; agent: AgentRole; text: string; pending: { action: string; appointmentId: string | null } | null; decided?: "sent" | "declined" }
  | { id: number; from: "error"; text: string };

function MyQuestions({ patientId }: { patientId: string }) {
  const api = useApi();
  const query = useLiveQuery(["gp-queries", "mine", patientId], async () => {
    const [rows, appointments] = await Promise.all([api.listGpQueries(), api.listAppointments({ patientId, ascending: false })]);
    return { rows, appointments };
  }, { intervalMs: 15_000 });
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
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const nextId = useRef(1);
  const logRef = useRef<HTMLOListElement>(null);
  const patientId = me.data?.patient?.id ?? "";

  useEffect(() => {
    logRef.current?.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [turns.length]);

  const ask = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setDraft("");
    setTurns((t) => [...t, { id: nextId.current++, from: "patient", text: message }]);
    setBusy(true);
    try {
      const res = await agents.chat({ message });
      setTurns((t) => [
        ...t,
        {
          id: nextId.current++,
          from: "agent",
          agent: res.agent,
          text: res.answer,
          pending: res.pending_action ? { action: res.pending_action, appointmentId: res.appointment_id } : null,
        },
      ]);
    } catch (err) {
      setTurns((t) => [...t, { id: nextId.current++, from: "error", text: agentErrorMessage(err) }]);
    } finally {
      setBusy(false);
    }
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
    setTurns((t) => t.map((x) => (x.id === turnId && x.from === "agent" ? { ...x, decided: send ? "sent" : "declined" } : x)));
  };

  const emergency = containsEmergencyWords(draft) || turns.some((t) => t.from === "patient" && containsEmergencyWords(t.text));

  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <PageHeader
        title="AI assistant"
        description="A team of AI agents that answer from your approved record, your insurance plan and clinic fees. It doesn't diagnose or give medical advice."
        actions={
          turns.length ? (
            <Button variant="outline" onClick={() => setTurns([])}>
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
          sends it only if you approve. This conversation isn&apos;t saved. For emergencies call 000. To find and book care, use{" "}
          <Link href="/patient/concierge" className="underline">
            the care concierge
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
                    {t.from === "agent" && t.pending ? (
                      <div className="grid gap-2 rounded-md border bg-background p-3">
                        <p className="font-medium">Send this question to your clinician?</p>
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
