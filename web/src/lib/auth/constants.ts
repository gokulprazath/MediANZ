// Clinician and staff sessions end after 30 minutes without activity.
export const IDLE_LIMIT_MS = 30 * 60 * 1000;
// Last-activity time (ms since epoch). No personal or health data.
export const IDLE_COOKIE = "mz_last_active";

export const PUBLIC_PATHS = ["/login", "/signup", "/reset-password", "/auth", "/privacy", "/api/mock"];
export const AAL2_PREFIXES = ["/clinician", "/staff"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function needsAal2(pathname: string): boolean {
  return AAL2_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Only same-site relative paths are followed after login. */
export function safeNext(next: string | null | undefined, fallback = "/"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}
