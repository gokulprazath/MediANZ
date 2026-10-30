// Chunked consult recording for the transcribe-consult Edge Function.
//
// A consult of 15 minutes or less is sent as one file (seq 1) when it stops.
// If it reaches 15 minutes, that file is sent as seq 1 and the recorder is
// restarted every 5 minutes; each complete file is the next seq. Every file is
// a complete recording (its own MediaRecorder), so the server can transcribe it
// on its own. A failed upload is retried with the same seq. Audio blobs live in
// memory only, until their upload succeeds.

export const FIRST_CHUNK_MS = 15 * 60_000;
export const NEXT_CHUNK_MS = 5 * 60_000;
export const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000];

export interface RecorderLike {
  state: "inactive" | "recording" | "paused";
  mimeType: string;
  start(): void;
  stop(): void;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror?: ((e: unknown) => void) | null;
}

export type UploadResult = { status: "stored" | "discarded"; reason?: string };

export interface ChunkedRecorderDeps {
  createRecorder: () => RecorderLike;
  upload: (seq: number, blob: Blob, durationSeconds: number) => Promise<UploadResult>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
  firstChunkMs?: number;
  nextChunkMs?: number;
  retryDelaysMs?: number[];
  onChange?: () => void;
}

export type RecorderPhase = "idle" | "recording" | "stopping" | "stopped" | "discarded" | "failed";

interface Pending {
  seq: number;
  blob: Blob;
  seconds: number;
}

export class ChunkedRecorder {
  phase: RecorderPhase = "idle";
  /** Seq numbers whose upload has succeeded. */
  readonly sent: number[] = [];
  /** The last upload error, while retrying or after giving up. */
  lastError: unknown = null;
  discardReason: string | null = null;
  startedAt: number | null = null;

  private recorder: RecorderLike | null = null;
  private seq = 0;
  private fileStartedAt = 0;
  private timer: unknown = null;
  private queue: Pending[] = [];
  private uploading: Promise<void> | null = null;
  private ending = false;
  private closing = new Set<Promise<void>>();
  private readonly d: Required<Omit<ChunkedRecorderDeps, "onChange">> & { onChange?: () => void };

  constructor(deps: ChunkedRecorderDeps) {
    this.d = {
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      firstChunkMs: FIRST_CHUNK_MS,
      nextChunkMs: NEXT_CHUNK_MS,
      retryDelaysMs: RETRY_DELAYS_MS,
      ...deps,
    };
  }

  /** Chunks recorded but not yet uploaded. */
  get pendingCount(): number {
    return this.queue.length;
  }

  start(): void {
    if (this.phase !== "idle") throw new Error("Recorder already used");
    this.phase = "recording";
    this.startedAt = this.d.now();
    this.startFile();
    this.schedule(this.d.firstChunkMs);
    this.changed();
  }

  /** Stop recording, send the last file and wait until every chunk is stored. */
  async stop(): Promise<void> {
    if (this.phase !== "recording") return;
    this.phase = "stopping";
    this.ending = true;
    this.clear();
    this.changed();
    await this.closeFile();
    await Promise.all([...this.closing]);
    await this.drain();
    if (this.phase === "stopping") this.phase = this.queue.length ? "failed" : "stopped";
    this.changed();
  }

  /** Throw away everything recorded on this device (Cancel or consent withdrawn). */
  discard(reason = "cancelled"): void {
    this.ending = true;
    this.clear();
    this.queue = [];
    this.discardReason = reason;
    this.phase = "discarded";
    const r = this.recorder;
    this.recorder = null;
    if (r && r.state !== "inactive") {
      r.ondataavailable = null;
      r.onstop = null;
      r.stop();
    }
    this.changed();
  }

  /** After giving up on an upload: try the remaining chunks again (same seq). */
  async retry(): Promise<void> {
    if (this.phase !== "failed") return;
    this.phase = "stopping";
    this.lastError = null;
    this.changed();
    await this.drain();
    if (this.phase === "stopping") this.phase = this.queue.length ? "failed" : "stopped";
    this.changed();
  }

  private changed() {
    this.d.onChange?.();
  }

  private schedule(ms: number) {
    this.timer = this.d.setTimer(() => void this.rotate(), ms);
  }

  private clear() {
    if (this.timer !== null) this.d.clearTimer(this.timer);
    this.timer = null;
  }

  private startFile() {
    const r = this.d.createRecorder();
    this.recorder = r;
    this.fileStartedAt = this.d.now();
    r.start();
  }

  /** Stop the current recorder and queue its complete file as the next seq. */
  private closeFile(): Promise<void> {
    const r = this.recorder;
    if (!r) return Promise.resolve();
    this.recorder = null;
    const startedAt = this.fileStartedAt;
    const done = new Promise<void>((resolve) => {
      const parts: Blob[] = [];
      r.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) parts.push(e.data);
      };
      r.onstop = () => {
        if (this.phase !== "discarded" && parts.length) {
          this.seq += 1;
          const blob = new Blob(parts, { type: r.mimeType || parts[0].type });
          this.queue.push({ seq: this.seq, blob, seconds: (this.d.now() - startedAt) / 1000 });
          void this.drain();
        }
        resolve();
      };
      if (r.state === "inactive") r.onstop();
      else r.stop();
    });
    this.closing.add(done);
    void done.then(() => this.closing.delete(done));
    return done;
  }

  /** 15 minutes reached (then every 5): close this file and start the next one. */
  private async rotate() {
    if (this.phase !== "recording" || this.ending) return;
    const closing = this.closeFile();
    this.startFile();
    this.schedule(this.d.nextChunkMs);
    await closing;
  }

  /** Upload queued chunks in order, retrying each with the same seq. */
  private drain(): Promise<void> {
    if (this.uploading) return this.uploading;
    if (!this.queue.length) return Promise.resolve();
    const run = (async () => {
      await Promise.resolve(); // let `this.uploading` be set first
      try {
        while (this.queue.length && this.phase !== "discarded") {
          const ok = await this.uploadWithRetry(this.queue[0]);
          if (!ok) return;
          this.queue.shift();
        }
      } finally {
        this.uploading = null;
      }
    })();
    this.uploading = run;
    return run;
  }

  private async uploadWithRetry(p: Pending): Promise<boolean> {
    const delays = this.d.retryDelaysMs;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.d.upload(p.seq, p.blob, p.seconds);
        this.lastError = null;
        if (res.status === "discarded") {
          // The server stopped the session (consent withdrawn): stop here too.
          this.discard(res.reason ?? "discarded");
          return false;
        }
        this.sent.push(p.seq);
        this.changed();
        return true;
      } catch (err) {
        this.lastError = err;
        this.changed();
        if (this.phase === "discarded") return false;
        if (attempt >= delays.length) {
          if (this.phase === "stopping") this.phase = "failed";
          return false;
        }
        await this.d.sleep(delays[attempt]);
      }
    }
  }
}

/** The best audio format this browser records, for MediaRecorder. */
export function pickAudioMimeType(isSupported: (t: string) => boolean): string | undefined {
  for (const t of ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"]) {
    if (isSupported(t)) return t;
  }
  return undefined;
}
