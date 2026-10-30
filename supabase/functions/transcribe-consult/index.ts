// supabase/functions/transcribe-consult/index.ts
//
// Chunked consult transcription with ElevenLabs Scribe.
// Audio is transcribed IN MEMORY and never written to Storage, disk or the
// database. Only the text is kept: per chunk while recording, then joined
// into one draft transcript that the patient approves or rejects.
//
// Needs migration 20261028100000_chunked_transcription.sql.
//
// Every request needs the signed-in user's Supabase token:
//   Authorization: Bearer <user access token>
//
// Actions
//   1. start   JSON      { "action": "start", "appointment_id": "<uuid>" }
//              -> { session_id }
//   2. chunk   multipart action=chunk, session_id, seq (1, 2, 3, ...),
//              audio (file), duration_seconds (optional)
//              -> { status: "stored", seq }   (re-send the same seq to retry)
//   3. finish  JSON      { "action": "finish", "session_id": "<uuid>" }
//              -> { transcript_id, status: "pending_patient_review" }
//   4. cancel  JSON      { "action": "cancel", "session_id": "<uuid>" }
//              -> { status: "cancelled" }   (stored chunk text is deleted)
//
// Secrets (Edge Functions -> Secrets):
//   ELEVENLABS_API_KEY          required
//   ELEVENLABS_STT_MODEL        optional, default "scribe_v2"
//   ELEVENLABS_LANGUAGE         optional, default "en"
//   ELEVENLABS_KEYTERMS         optional, comma-separated terms (adds ElevenLabs' keyterm surcharge)
//   ELEVENLABS_ZERO_RETENTION   "true" only once your ElevenLabs Enterprise account has
//                               Zero Retention Mode (sends enable_logging=false)
//   ELEVENLABS_API_URL          optional override (testing only)
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided
// automatically inside Supabase Edge Functions.

import { createClient } from "jsr:@supabase/supabase-js@2";

const DEFAULT_ELEVENLABS_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const MAX_CHUNK_BYTES = 25 * 1024 * 1024; // a 5-minute Opus/AAC chunk is ~1-3 MB
const MAX_SEGMENT_SECONDS = 30;           // split long single-speaker stretches
const ELEVENLABS_TIMEOUT_MS = 110_000;    // stay under the 150 s response limit
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// ElevenLabs
// ---------------------------------------------------------------------------
type Segment = { speaker: string; start_sec: number; end_sec: number; text: string };

type ScribeWord = {
  text?: string;
  start?: number | null;
  end?: number | null;
  type?: string; // "word" | "spacing" | "audio_event"
  speaker_id?: string | null;
};

type Transcription = { text: string; segments: Segment[]; model: string };

class TranscriptionError extends Error {}

function fileNameFor(mime: string): string {
  if (mime.includes("webm")) return "chunk.webm";
  if (mime.includes("ogg") || mime.includes("opus")) return "chunk.ogg";
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) return "chunk.m4a";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "chunk.mp3";
  if (mime.includes("wav")) return "chunk.wav";
  if (mime.includes("flac")) return "chunk.flac";
  return "chunk";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Group ElevenLabs' word list into speaker turns: a new segment starts when
// the speaker changes or a turn passes MAX_SEGMENT_SECONDS.
export function wordsToSegments(words: ScribeWord[]): Segment[] {
  const segments: Segment[] = [];
  const pending: Segment[] = []; // holds at most one open segment
  let lastEnd = 0;

  const close = (): void => {
    const seg = pending.pop();
    if (!seg) return;
    seg.text = seg.text.replace(/\s+/g, " ").trim();
    if (seg.text) segments.push(seg);
  };

  for (const w of words) {
    if (w.type === "audio_event") continue;
    const text: string = w.text ?? "";
    const open: Segment | undefined = pending[0];

    if (w.type === "spacing") {
      if (open) open.text += text;
      continue;
    }

    const speaker: string = w.speaker_id ?? "unknown";
    const start: number = typeof w.start === "number" ? w.start : lastEnd;
    const end: number = typeof w.end === "number" ? w.end : start;
    lastEnd = end;

    if (!open || open.speaker !== speaker || start - open.start_sec > MAX_SEGMENT_SECONDS) {
      close();
      pending.push({ speaker, start_sec: round2(start), end_sec: round2(end), text });
    } else {
      open.text += text;
      open.end_sec = round2(end);
    }
  }
  close();
  return segments;
}

async function transcribe(audio: Blob): Promise<Transcription> {
  const apiKey = Deno.env.get("ELEVENLABS_API_KEY");
  if (!apiKey) throw new TranscriptionError("ELEVENLABS_API_KEY is not set");

  const model = Deno.env.get("ELEVENLABS_STT_MODEL") || "scribe_v2";
  const form = new FormData();
  form.append("model_id", model);
  form.append("file", audio, fileNameFor(audio.type));
  form.append("language_code", Deno.env.get("ELEVENLABS_LANGUAGE") || "en");
  form.append("diarize", "true");
  form.append("tag_audio_events", "false");
  form.append("timestamps_granularity", "word");
  // Keyterms: sent as repeated form fields. If ElevenLabs rejects this
  // format (HTTP 422), check their API reference and adjust.
  for (const term of (Deno.env.get("ELEVENLABS_KEYTERMS") ?? "").split(",")) {
    const t = term.trim();
    if (t) form.append("keyterms", t);
  }

  const url = new URL(Deno.env.get("ELEVENLABS_API_URL") || DEFAULT_ELEVENLABS_URL);
  if (Deno.env.get("ELEVENLABS_ZERO_RETENTION") === "true") {
    url.searchParams.set("enable_logging", "false");
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
      signal: AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS),
    });
  } catch (err) {
    throw new TranscriptionError(`ElevenLabs request failed: ${(err as Error).name}`);
  }

  if (!res.ok) {
    // Error bodies describe the request problem, not the audio content.
    const detail = (await res.text()).slice(0, 300);
    throw new TranscriptionError(`ElevenLabs returned ${res.status}: ${detail}`);
  }

  const data = await res.json();
  if (Array.isArray(data?.transcripts)) {
    throw new TranscriptionError("Unexpected multichannel response");
  }

  return {
    text: String(data?.text ?? "").trim(),
    segments: wordsToSegments(Array.isArray(data?.words) ? data.words : []),
    model,
  };
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------
type Clients = {
  // deno-lint-ignore no-explicit-any
  user: any;  // acts as the signed-in user (RLS and consent checks apply)
  // deno-lint-ignore no-explicit-any
  admin: any; // service role, only for storing text after the user checks pass
};

function makeClients(authHeader: string): Clients {
  const url = Deno.env.get("SUPABASE_URL")!;
  return {
    user: createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    }),
    admin: createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    }),
  };
}

async function checkAllowed(c: Clients, sessionId: string, forFinish: boolean): Promise<Response | null> {
  const { error } = await c.user.rpc("check_recording_chunk_allowed", {
    p_session_id: sessionId,
    p_for_finish: forFinish,
  });
  return error ? json({ error: error.message }, 403) : null;
}

async function handleStart(c: Clients, body: Record<string, unknown>): Promise<Response> {
  const appointmentId = String(body.appointment_id ?? "");
  if (!UUID_RE.test(appointmentId)) return json({ error: "appointment_id is required" }, 400);

  const { data, error } = await c.user.rpc("start_recording_session", { p_appointment_id: appointmentId });
  if (error || !data) return json({ error: error?.message ?? "Recording not allowed" }, 403);
  return json({ session_id: data });
}

async function handleChunk(c: Clients, form: FormData): Promise<Response> {
  const sessionId = String(form.get("session_id") ?? "");
  const seq = Number.parseInt(String(form.get("seq") ?? ""), 10);
  const audio = form.get("audio");
  const durationRaw = form.get("duration_seconds");
  const duration = durationRaw === null ? null : Number(durationRaw);

  if (!UUID_RE.test(sessionId)) return json({ error: "session_id is required" }, 400);
  if (!Number.isInteger(seq) || seq < 1 || seq > 500) return json({ error: "seq must be 1-500" }, 400);
  if (!(audio instanceof Blob) || audio.size === 0) return json({ error: "audio is required" }, 400);
  if (audio.size > MAX_CHUNK_BYTES) return json({ error: "Chunk too large; send shorter chunks" }, 413);
  if (duration !== null && !(Number.isFinite(duration) && duration >= 0)) {
    return json({ error: "duration_seconds must be a positive number" }, 400);
  }

  // 1. The user must be a participant, the session open, consent in place.
  const denied = await checkAllowed(c, sessionId, false);
  if (denied) return denied;

  // 2. Transcribe in memory. On failure nothing is stored; the app retries the same seq.
  let result: Transcription;
  try {
    result = await transcribe(audio);
  } catch (err) {
    console.error("transcription failed", { sessionId, seq, error: String(err) });
    return json({ error: "Transcription failed, please retry this chunk" }, 502);
  }

  // 3. Store the text only. Returns false if consent was withdrawn meanwhile.
  const { data: stored, error } = await c.admin.rpc("append_transcript_chunk", {
    p_session_id: sessionId,
    p_seq: seq,
    p_transcript_text: result.text,
    p_segments: result.segments,
    p_duration_seconds: duration,
    p_engine: "elevenlabs",
    p_engine_model: result.model,
  });
  if (error) return json({ error: error.message }, 409);
  if (stored === false) return json({ status: "discarded", reason: "consent_withdrawn" }, 409);

  return json({ status: "stored", seq });
  // `audio` goes out of scope here; it was never written anywhere.
}

async function handleFinish(c: Clients, body: Record<string, unknown>): Promise<Response> {
  const sessionId = String(body.session_id ?? "");
  if (!UUID_RE.test(sessionId)) return json({ error: "session_id is required" }, 400);

  const denied = await checkAllowed(c, sessionId, true);
  if (denied) return denied;

  const { data, error } = await c.admin.rpc("finalize_transcript_from_chunks", {
    p_session_id: sessionId,
    p_language: "en-AU",
  });
  if (error) return json({ error: error.message }, 409);
  if (!data) return json({ status: "discarded", reason: "no_speech_or_consent_withdrawn" }, 409);

  return json({ transcript_id: data, status: "pending_patient_review" });
}

async function handleCancel(c: Clients, body: Record<string, unknown>): Promise<Response> {
  const sessionId = String(body.session_id ?? "");
  if (!UUID_RE.test(sessionId)) return json({ error: "session_id is required" }, 400);

  const denied = await checkAllowed(c, sessionId, true);
  if (denied) return denied;

  const { error } = await c.admin.rpc("mark_recording_failed", {
    p_session_id: sessionId,
    p_error: "Cancelled by user",
  });
  if (error) return json({ error: error.message }, 409);
  return json({ status: "cancelled" });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "Missing Authorization header" }, 401);

  const clients = makeClients(authHeader);
  const contentType = req.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const action = String(form.get("action") ?? "chunk");
      if (action !== "chunk") return json({ error: "Multipart requests are only for action=chunk" }, 400);
      return await handleChunk(clients, form);
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json({ error: "Expected JSON or multipart/form-data" }, 400);

    switch (body.action) {
      case "start":  return await handleStart(clients, body);
      case "finish": return await handleFinish(clients, body);
      case "cancel": return await handleCancel(clients, body);
      default:       return json({ error: "Unknown action" }, 400);
    }
  } catch (err) {
    console.error("unexpected error", String(err));
    return json({ error: "Unexpected error" }, 500);
  }
});
