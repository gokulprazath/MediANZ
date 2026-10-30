// Chunking plan: one file up to 15 min; then seq 1 at 15 min and a new file
// every 5 min; failed uploads retry with the same seq.
import { describe, expect, it, vi } from "vitest";
import { ChunkedRecorder, pickAudioMimeType, type RecorderLike, type UploadResult } from "@/features/consult/chunked-recorder";

class FakeRecorder implements RecorderLike {
  state: RecorderLike["state"] = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob([new Uint8Array(10)]) });
      this.onstop?.();
    });
  }
}

function setup(upload: (seq: number, blob: Blob, secs: number) => Promise<UploadResult>) {
  let t = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const recorders: FakeRecorder[] = [];
  const rec = new ChunkedRecorder({
    createRecorder: () => {
      const r = new FakeRecorder();
      recorders.push(r);
      return r;
    },
    upload,
    now: () => t,
    setTimer: (fn, ms) => {
      const timer = { at: t + ms, fn };
      timers.push(timer);
      return timer;
    },
    clearTimer: (x) => {
      const i = timers.indexOf(x as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
    sleep: () => Promise.resolve(),
  });
  const advance = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      t = next.at;
      next.fn();
      await new Promise((r) => setTimeout(r, 0));
    }
    t = end;
  };
  return { rec, recorders, advance };
}

describe("ChunkedRecorder", () => {
  it("sends one file when the consult is 15 minutes or less", async () => {
    const upload = vi.fn(async (...args: [number, Blob, number]) => (void args, { status: "stored" as const }));
    const { rec, recorders, advance } = setup(upload);
    rec.start();
    await advance(10 * 60_000);
    await rec.stop();
    expect(recorders).toHaveLength(1);
    expect(upload.mock.calls.map((c) => [c[0], c[2]])).toEqual([[1, 600]]);
    expect(rec.phase).toBe("stopped");
  });

  it("sends seq 1 at 15 minutes, then a file every 5 minutes", async () => {
    const upload = vi.fn(async (...args: [number, Blob, number]) => (void args, { status: "stored" as const }));
    const { rec, recorders, advance } = setup(upload);
    rec.start();
    await advance(27 * 60_000);
    await rec.stop();
    expect(recorders).toHaveLength(4); // 0-15, 15-20, 20-25, 25-27
    expect(upload.mock.calls.map((c) => [c[0], c[2]])).toEqual([
      [1, 900],
      [2, 300],
      [3, 300],
      [4, 120],
    ]);
    expect(rec.sent).toEqual([1, 2, 3, 4]);
  });

  it("retries a failed chunk with the same seq, then reports failure and can retry later", async () => {
    let fail = 6; // more than the 4 retries
    const upload = vi.fn(async (...args: [number, Blob, number]) => {
      void args;
      if (fail-- > 0) throw new Error("network");
      return { status: "stored" as const };
    });
    const { rec, advance } = setup(upload);
    rec.start();
    await advance(60_000);
    await rec.stop();
    expect(rec.phase).toBe("failed");
    expect(rec.pendingCount).toBe(1);
    expect(upload.mock.calls.every((c) => c[0] === 1)).toBe(true);
    await rec.retry();
    expect(rec.phase).toBe("stopped");
    expect(rec.sent).toEqual([1]);
  });

  it("stops when the server discards (consent withdrawn), and discard drops everything", async () => {
    const upload = vi.fn(async () => ({ status: "discarded" as const, reason: "consent_withdrawn" }));
    const { rec, advance } = setup(upload);
    rec.start();
    await advance(16 * 60_000);
    expect(rec.phase).toBe("discarded");
    expect(rec.discardReason).toBe("consent_withdrawn");

    const ok = vi.fn(async (...args: [number, Blob, number]) => (void args, { status: "stored" as const }));
    const second = setup(ok);
    second.rec.start();
    second.rec.discard();
    await second.advance(20 * 60_000);
    expect(ok).not.toHaveBeenCalled();
  });

  it("picks the first supported audio type", () => {
    expect(pickAudioMimeType((t) => t === "audio/mp4")).toBe("audio/mp4");
    expect(pickAudioMimeType(() => false)).toBeUndefined();
  });
});
