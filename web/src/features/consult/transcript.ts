// Speaker turns for showing a transcript. Segments come from
// finalize_transcript_from_chunks as "c<seq>:<speaker>"; diarisation is per
// chunk, so speakers are numbered per part and not matched across parts.
import type { ConsultTranscript } from "@/types/db";

export interface SpeakerTurn {
  speaker: string; // display label
  startSec: number | null;
  text: string;
}

export function speakerTurns(t: Pick<ConsultTranscript, "segments" | "transcript_text">): SpeakerTurn[] {
  if (!t.segments?.length) {
    return [{ speaker: "Transcript", startSec: null, text: t.transcript_text }];
  }
  const multiPart = new Set(t.segments.map((s) => s.chunk ?? 1)).size > 1;
  const numbers = new Map<string, number>(); // per part
  const turns: (SpeakerTurn & { key: string })[] = [];
  for (const s of t.segments) {
    const m = /^c(\d+):(.*)$/.exec(s.speaker ?? "");
    const part = s.chunk ?? (m ? Number(m[1]) : 1);
    const raw = m ? m[2] : (s.speaker ?? "unknown");
    const key = `${part}|${raw}`;
    if (!numbers.has(key)) {
      const inPart = [...numbers.keys()].filter((k) => k.startsWith(`${part}|`)).length;
      numbers.set(key, inPart + 1);
    }
    const label = `Speaker ${numbers.get(key)}${multiPart ? ` (part ${part})` : ""}`;
    const last = turns[turns.length - 1];
    if (last && last.key === key) {
      last.text = `${last.text} ${s.text.trim()}`.trim();
    } else {
      turns.push({ key, speaker: label, startSec: s.start_sec, text: s.text.trim() });
    }
  }
  return turns.map(({ speaker, startSec, text }) => ({ speaker, startSec, text }));
}

export function formatOffset(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
