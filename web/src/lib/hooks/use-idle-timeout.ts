"use client";
// Clinician and staff idle timeout (30 minutes). Activity refreshes the
// last-activity cookie that proxy.ts also checks; after 30 minutes without
// activity the user is signed out.
import { useEffect } from "react";
import { IDLE_LIMIT_MS } from "@/lib/auth/constants";
import { getAuthClient, markActive } from "@/lib/auth/client";

const EVENTS = ["pointerdown", "keydown", "scroll", "touchstart"] as const;

export function useIdleTimeout(enabled: boolean, limitMs = IDLE_LIMIT_MS) {
  useEffect(() => {
    if (!enabled) return;
    let last = Date.now();
    let lastWrite = 0;
    markActive();
    const onActivity = () => {
      last = Date.now();
      if (last - lastWrite > 30_000) {
        lastWrite = last;
        markActive();
      }
    };
    for (const e of EVENTS) window.addEventListener(e, onActivity, { passive: true });
    const timer = setInterval(async () => {
      if (Date.now() - last > limitMs) {
        clearInterval(timer);
        await getAuthClient().signOut().catch(() => undefined);
        window.location.assign("/login?reason=idle");
      }
    }, 15_000);
    return () => {
      clearInterval(timer);
      for (const e of EVENTS) window.removeEventListener(e, onActivity);
    };
  }, [enabled, limitMs]);
}
