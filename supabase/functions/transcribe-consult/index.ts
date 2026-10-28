// supabase/functions/transcribe-consult/index.ts
//
// Receives consult audio, transcribes it IN MEMORY, saves a draft transcript
// for the patient to review, and never writes the audio anywhere.
//
// Request (multipart/form-data), with the user's Supabase JWT in Authorization:
//   appointment_id    uuid
//   audio             file (e.g. audio/webm, audio/wav, audio/mp4)
//   duration_seconds  optional integer
//
// Secrets to set (supabase secrets set ...):
//   STT_API_URL          OpenAI-compatible transcription endpoint, e.g.
//                        https://api.tokenfactory.nebius.com/v1/audio/transcriptions
//   STT_API_KEY          provider API key
//   STT_MODEL            speech-to-text model id from the provider's catalogue
//   STT_ENGINE           optional engine name stored on the session (default "nebius")
//   CORS_ALLOWED_ORIGIN  optional comma-separated web origins allowed to call this
//                        function (e.g. the Flutter web app); "*" when not set
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided
// automatically inside Supabase Edge Functions.

import { createClient } from "jsr:@supabase/supabase-js@2";

const MAX_AUDIO_BYTES = 50 * 1024 * 1024; // adjust to your plan's request limits

function corsHeaders(req: Request): Record<string, string> {
  const allowed = (Deno.env.get("CORS_ALLOWED_ORIGIN") ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const origin = req.headers.get("Origin") ?? "";
  const allowOrigin = allowed.length === 0 ? "*" : allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

type SttResult = {
  text: string;
  segments?: { speaker?: string; start_sec: number; end_sec: number; text: string }[];
  language?: string;
};

// The provider needs a file name with a matching extension to detect the format.
const EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/flac": "flac",
};

function fileName(audio: Blob): string {
  const mime = (audio.type || "").split(";")[0].trim().toLowerCase();
  return `consult.${EXTENSIONS[mime] ?? "webm"}`;
}

// OpenAI-compatible /v1/audio/transcriptions (Nebius Token Factory or any other
// compatible provider). Requirements for the provider: no retention of audio,
// a known processing region, and a signed data-processing agreement.
async function transcribe(audio: Blob): Promise<SttResult> {
  const body = new FormData();
  body.append("file", audio, fileName(audio));
  body.append("model", Deno.env.get("STT_MODEL")!);
  body.append("response_format", "verbose_json");
  body.append("timestamp_granularities[]", "segment");

  const res = await fetch(Deno.env.get("STT_API_URL")!, {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("STT_API_KEY")}` },
    body,
  });
  if (!res.ok) {
    // Status only: the provider's error body can echo request details.
    throw new Error(`Speech-to-text failed: ${res.status}`);
  }

  const data = await res.json();
  const text = typeof data.text === "string" ? data.text.trim() : "";
  if (!text) throw new Error("Speech-to-text returned no text");

  const segments = Array.isArray(data.segments)
    ? data.segments
      .filter((s: { text?: unknown }) => typeof s.text === "string" && s.text.trim() !== "")
      .map((s: { start?: number; end?: number; text: string }) => ({
        start_sec: typeof s.start === "number" ? s.start : 0,
        end_sec: typeof s.end === "number" ? s.end : 0,
        text: s.text.trim(),
      }))
    : undefined;

  // verbose_json reports a language name ("english"); keep a BCP 47 tag only.
  const language = typeof data.language === "string" && /^[a-z]{2}(-[A-Z]{2})?$/.test(data.language)
    ? data.language
    : "en-AU";

  return { text, segments: segments?.length ? segments : undefined, language };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json(req, { error: "Missing Authorization header" }, 401);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(req, { error: "Expected multipart/form-data" }, 400);
  }

  const appointmentId = form.get("appointment_id");
  const audio = form.get("audio");
  const durationRaw = form.get("duration_seconds");
  const durationSeconds = durationRaw ? Number.parseInt(String(durationRaw), 10) : null;

  if (typeof appointmentId !== "string" || !(audio instanceof Blob)) {
    return json(req, { error: "appointment_id and audio are required" }, 400);
  }
  if (audio.size === 0 || audio.size > MAX_AUDIO_BYTES) {
    return json(req, { error: "Audio is empty or too large" }, 413);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;

  // Runs as the caller: the database checks they are the patient or clinician,
  // that the consult is in progress, and that BOTH parties have consented.
  const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });

  // Service role: only used for save_transcript_draft / mark_recording_failed.
  const adminClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: sessionId, error: startError } = await userClient.rpc(
    "start_recording_session",
    { p_appointment_id: appointmentId },
  );
  if (startError || !sessionId) {
    return json(req, { error: startError?.message ?? "Recording not allowed" }, 403);
  }

  try {
    // The audio only ever exists in this function's memory.
    const result = await transcribe(audio);

    const { data: transcriptId, error: saveError } = await adminClient.rpc(
      "save_transcript_draft",
      {
        p_session_id: sessionId,
        p_transcript_text: result.text,
        p_segments: result.segments ?? null,
        p_summary_text: null, // key points are produced after the patient approves
        p_language: result.language ?? "en-AU",
        p_engine: Deno.env.get("STT_ENGINE") ?? "nebius",
        p_engine_model: Deno.env.get("STT_MODEL") ?? null,
        p_duration_seconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
      },
    );
    if (saveError) throw new Error(saveError.message);

    if (!transcriptId) {
      // Consent was withdrawn while transcribing; nothing was stored.
      return json(req, { status: "discarded", reason: "consent_withdrawn" }, 409);
    }

    return json(req, { transcript_id: transcriptId, status: "pending_patient_review" });
  } catch (err) {
    await adminClient.rpc("mark_recording_failed", {
      p_session_id: sessionId,
      p_error: String(err),
    });
    return json(req, { error: "Transcription failed" }, 502);
  }
  // `audio` goes out of scope here and is garbage-collected; it was never
  // written to Storage, disk or the database.
});
