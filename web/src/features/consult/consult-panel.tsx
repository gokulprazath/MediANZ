"use client";
// Consent and recording for one appointment, shared by the patient's
// appointment-day page (4.5) and the clinician's consult view (5.2).
// Consents and recording sessions are polled every 5 s (useLiveQuery), so the
// patient's and clinician's screens stay in step.
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, Mic, Square } from "lucide-react";
import Link from "next/link";
import { useEffect, useReducer, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CONSENT_POINTS, CONSENT_TITLE, CONSENT_VERSION } from "@/config/consent";
import type { DataApi } from "@/lib/data/api";
import { useApi } from "@/lib/data/context";
import { friendlyError } from "@/lib/errors";
import { useLiveQuery } from "@/lib/hooks/use-live-query";
import { formatCountdown } from "@/lib/time";
import type { AppointmentWithRefs, ConsentParty, RecordingConsent, RecordingSession } from "@/types/db";
import { ChunkedRecorder, pickAudioMimeType, type RecorderLike } from "./chunked-recorder";

const RECORDABLE = new Set(["checked_in", "in_consultation"]);

export function activeConsent(consents: RecordingConsent[], party: ConsentParty): RecordingConsent | null {
  return consents.find((c) => c.party === party && c.consent_given && !c.withdrawn_at) ?? null;
}

const OTHER: Record<ConsentParty, ConsentParty> = { patient: "clinician", clinician: "patient" };
const OTHER_LABEL: Record<ConsentParty, string> = { patient: "your clinician", clinician: "the patient" };
const OTHER_DEVICE: Record<ConsentParty, string> = {
  patient: "Recording on the clinician's device",
  clinician: "Recording on the patient's device",
};

function micErrorMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access was blocked. Allow the microphone for this site in your browser settings, then try again.";
  }
  if (name === "NotFoundError") return "No microphone was found on this device.";
  return "The microphone couldn't be started on this device.";
}

/** Drives one ChunkedRecorder against the transcribe-consult API. */
function useConsultRecorder(api: DataApi, appointmentId: string, onFinished: (transcriptId: string | null) => void) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  type Active = { rec: ChunkedRecorder; sessionId: string; stream: MediaStream };
  // State for rendering; the ref for handlers and unmount cleanup.
  const [active, setActiveState] = useState<Active | null>(null);
  const ref = useRef<Active | null>(null);
  const setActive = (v: Active | null) => {
    ref.current = v;
    setActiveState(v);
  };
  const [starting, setStarting] = useState(false);
  const [finishing, setFinishing] = useState(false);

  const release = () => {
    ref.current?.stream.getTracks().forEach((t) => t.stop());
  };

  // Leaving the page while recording: stop the microphone and cancel the session.
  useEffect(
    () => () => {
      const cur = ref.current;
      if (cur && (cur.rec.phase === "recording" || cur.rec.phase === "stopping")) {
        cur.rec.discard("left_page");
        cur.stream.getTracks().forEach((t) => t.stop());
        void api.transcribeCancel(cur.sessionId).catch(() => undefined);
      }
    },
    [api],
  );

  useEffect(() => {
    if (!active || active.rec.phase !== "recording") return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  });

  const start = async () => {
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      toast.error("This browser can't record audio. Try a current version of Chrome, Edge, Firefox or Safari.");
      return;
    }
    setStarting(true);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      toast.error(micErrorMessage(err));
      setStarting(false);
      return;
    }
    try {
      const { session_id } = await api.transcribeStart(appointmentId);
      const mimeType = pickAudioMimeType((t) => MediaRecorder.isTypeSupported(t));
      const rec = new ChunkedRecorder({
        createRecorder: () => new MediaRecorder(stream, mimeType ? { mimeType } : undefined) as unknown as RecorderLike,
        upload: (seq, blob, seconds) => api.transcribeChunk(session_id, seq, blob, seconds),
        onChange: rerender,
      });
      setActive({ rec, sessionId: session_id, stream });
      rec.start();
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      toast.error(friendlyError(err));
    } finally {
      setStarting(false);
    }
  };

  const finish = async () => {
    const cur = ref.current;
    if (!cur) return;
    setFinishing(true);
    try {
      await cur.rec.stop();
      release();
      if (cur.rec.phase === "discarded") {
        toast.error("Recording stopped: consent was withdrawn. Nothing was kept.");
        setActive(null);
        return;
      }
      if (cur.rec.phase === "failed") {
        toast.error("Part of the recording couldn't be sent. Check your connection and retry.");
        return;
      }
      const res = await api.transcribeFinish(cur.sessionId);
      setActive(null);
      if (res.status === "pending_patient_review") {
        toast.success("Transcript drafted. The patient reviews it before anyone else can see it.");
        onFinished(res.transcript_id ?? null);
      } else {
        toast.error("No speech was transcribed, so nothing was kept.");
        onFinished(null);
      }
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setFinishing(false);
    }
  };

  const retry = async () => {
    const cur = ref.current;
    if (!cur) return;
    await cur.rec.retry();
    if (cur.rec.phase === "stopped") await finish();
  };

  const cancel = async () => {
    const cur = ref.current;
    if (!cur) return;
    cur.rec.discard("cancelled");
    release();
    setActive(null);
    try {
      await api.transcribeCancel(cur.sessionId);
      toast.success("Recording cancelled. Nothing was kept.");
    } catch (err) {
      toast.error(friendlyError(err));
    }
    onFinished(null);
  };

  /** Stop locally without telling the server (consent withdrawal deletes everything anyway). */
  const drop = () => {
    const cur = ref.current;
    if (!cur) return;
    cur.rec.discard("consent_withdrawn");
    release();
    setActive(null);
  };

  return { current: active, starting, finishing, start, finish, retry, cancel, drop };
}

function RecordingIndicator({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex items-center gap-2 rounded-md bg-danger-soft px-3 py-2 font-semibold text-destructive">
      <span className="relative flex size-3" aria-hidden="true">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-destructive opacity-60 motion-reduce:animate-none" />
        <span className="relative inline-flex size-3 rounded-full bg-destructive" />
      </span>
      {/* Announced once; the running time is not read out every second. */}
      <span role="status">Recording</span>
      <span role="timer" aria-live="off" aria-label="Time recorded" className="font-normal tabular-nums">
        {formatCountdown(now - since)}
      </span>
    </div>
  );
}

function ConsentRow({ label, consent }: { label: string; consent: RecordingConsent | null }) {
  return (
    <li className="flex items-center gap-2">
      {consent ? (
        <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
      ) : (
        <Circle className="size-4 text-muted-foreground" aria-hidden="true" />
      )}
      <span>
        {label}: <strong>{consent ? "agreed" : "not yet agreed"}</strong>
      </span>
    </li>
  );
}

export function ConsultPanel({
  appointment,
  party,
  userId,
  transcriptHref,
}: {
  appointment: AppointmentWithRefs;
  party: ConsentParty;
  userId: string;
  /** Where to send the user after a transcript is drafted (patient: review page). */
  transcriptHref?: (transcriptId: string) => string;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const id = appointment.id;
  const [busy, setBusy] = useState(false);
  const [drafted, setDrafted] = useState<string | null>(null);

  const consents = useLiveQuery(["consents", id], () => api.listConsents(id));
  const sessions = useLiveQuery(["recording-sessions", id], () => api.listRecordingSessions([id]));
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["consents", id] }),
      qc.invalidateQueries({ queryKey: ["recording-sessions", id] }),
      qc.invalidateQueries({ queryKey: ["transcripts"] }),
    ]);
  };
  const recorder = useConsultRecorder(api, id, (transcriptId) => {
    setDrafted(transcriptId);
    void refresh();
  });

  const mine = activeConsent(consents.data ?? [], party);
  const theirs = activeConsent(consents.data ?? [], OTHER[party]);
  const both = !!mine && !!theirs;
  const recordable = RECORDABLE.has(appointment.status);
  const local = recorder.current;
  const localActive = !!local && (local.rec.phase === "recording" || local.rec.phase === "stopping" || local.rec.phase === "failed");
  const openSessions: RecordingSession[] = (sessions.data ?? []).filter((s) => s.status === "started");
  const elsewhere = !localActive && openSessions.some((s) => s.started_by !== userId);
  const stale = !localActive ? openSessions.find((s) => s.started_by === userId) : undefined;

  // The other person withdrew while this device was recording: stop the microphone.
  useEffect(() => {
    if (localActive && consents.isSuccess && !both) {
      recorder.drop();
      toast.error("Consent was withdrawn, so the recording stopped. Nothing was kept.");
    }
  }, [localActive, consents.isSuccess, both, recorder]);

  const agree = async () => {
    setBusy(true);
    try {
      await api.giveConsent(id, CONSENT_VERSION, "in_app");
      await refresh();
      toast.success("Thanks, your consent is recorded");
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    try {
      if (localActive) recorder.drop();
      await api.withdrawConsent(id, null);
      setDrafted(null);
      await refresh();
      toast.success("Consent withdrawn. Any recording and transcript for this appointment were deleted.");
    } catch (err) {
      toast.error(friendlyError(err));
      throw err;
    }
  };

  return (
    <Card aria-labelledby="consent-title" role="region">
      <CardHeader>
        <CardTitle>
          <h2 id="consent-title" className="text-lg">
            {CONSENT_TITLE}
          </h2>
        </CardTitle>
        <CardDescription>Recording is optional. Your care is the same whether or not you agree.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <dl className="grid gap-3">
          {CONSENT_POINTS.map((p) => (
            <div key={p.heading}>
              <dt className="font-medium">{p.heading}</dt>
              <dd className="text-sm text-muted-foreground">{p.text}</dd>
            </div>
          ))}
        </dl>

        {consents.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{friendlyError(consents.error)}</AlertDescription>
          </Alert>
        ) : (
          <ul className="grid gap-1 text-sm" aria-live="polite">
            <ConsentRow label="You" consent={mine} />
            <ConsentRow label={party === "patient" ? "Your clinician" : "The patient"} consent={theirs} />
          </ul>
        )}

        <div className="flex flex-wrap gap-2">
          {!consents.isSuccess ? null : !mine ? (
            <Button onClick={agree} disabled={busy}>
              {busy ? "Saving…" : "I agree to recording"}
            </Button>
          ) : (
            <ConfirmAction
              trigger="Withdraw consent"
              variant="outline"
              title="Withdraw consent to recording?"
              description="Recording stops and every transcript for this appointment, including drafts, is deleted. This can't be undone."
              confirmLabel="Withdraw consent"
              onConfirm={withdraw}
            />
          )}
        </div>

        {mine && !theirs ? (
          <p className="text-sm text-muted-foreground" role="status">
            Waiting for {OTHER_LABEL[party]} to agree. Recording can start once you both have.
          </p>
        ) : null}

        {both && !recordable ? (
          <p className="text-sm text-muted-foreground">Recording is possible once the patient has checked in.</p>
        ) : null}

        {both && recordable ? (
          <section aria-labelledby="recording-title" className="grid gap-3 rounded-lg border p-4">
            <h3 id="recording-title" className="font-semibold">
              Recording
            </h3>
            {localActive && local ? (
              <>
                {local.rec.phase === "recording" && local.rec.startedAt ? (
                  <RecordingIndicator since={local.rec.startedAt} />
                ) : null}
                {local.rec.phase === "stopping" ? (
                  <p role="status">Sending the recording for transcription…</p>
                ) : null}
                {local.rec.phase === "failed" ? (
                  <Alert variant="destructive">
                    <AlertTitle>Part of the recording couldn&apos;t be sent</AlertTitle>
                    <AlertDescription>
                      It is kept in this page only until it is sent. Check your connection and retry, or cancel to
                      discard it.
                    </AlertDescription>
                  </Alert>
                ) : null}
                {local.rec.lastError && local.rec.phase === "recording" ? (
                  <p className="text-sm text-warning" role="status">
                    Connection problem: retrying the last part.
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {local.rec.phase === "failed" ? (
                    <Button onClick={() => void recorder.retry()}>Retry sending</Button>
                  ) : (
                    <Button onClick={() => void recorder.finish()} disabled={recorder.finishing}>
                      <Square aria-hidden="true" />
                      {recorder.finishing ? "Finishing…" : "Stop and transcribe"}
                    </Button>
                  )}
                  <ConfirmAction
                    trigger="Cancel recording"
                    variant="outline"
                    title="Cancel this recording?"
                    description="Everything recorded so far is discarded and no transcript is made."
                    confirmLabel="Cancel recording"
                    onConfirm={recorder.cancel}
                  />
                </div>
              </>
            ) : elsewhere ? (
              <p role="status" className="flex items-center gap-2 font-medium">
                <Mic className="size-4" aria-hidden="true" />
                {OTHER_DEVICE[party]}
              </p>
            ) : stale ? (
              <div className="grid gap-2">
                <p className="text-sm">A recording started on this account was interrupted (for example, the page was closed).</p>
                <div>
                  <Button
                    variant="outline"
                    onClick={async () => {
                      try {
                        await api.transcribeCancel(stale.id);
                        await refresh();
                        toast.success("Interrupted recording discarded");
                      } catch (err) {
                        toast.error(friendlyError(err));
                      }
                    }}
                  >
                    Discard interrupted recording
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {drafted && transcriptHref ? (
                  <Alert>
                    <AlertTitle>Draft transcript ready</AlertTitle>
                    <AlertDescription>
                      <Link className="underline" href={transcriptHref(drafted)}>
                        Review the transcript
                      </Link>{" "}
                      to approve or reject it.
                    </AlertDescription>
                  </Alert>
                ) : null}
                <div>
                  <Button onClick={() => void recorder.start()} disabled={recorder.starting}>
                    <Mic aria-hidden="true" />
                    {recorder.starting ? "Starting…" : "Start recording"}
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">
                  Uses this device&apos;s microphone. Only one device records at a time.
                </p>
              </>
            )}
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}
