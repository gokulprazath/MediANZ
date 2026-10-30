// Mock-mode session cookie. It names the signed-in mock user and their
// assurance level; it never holds health data. Read by proxy.ts and the mock
// API route. Unsigned on purpose: mock mode has no real accounts or data.
export const MOCK_SESSION_COOKIE = "mz_mock_session";

export interface MockSessionCookie {
  uid: string;
  email: string;
  role: "staff" | "admin" | null;
  aal: "aal1" | "aal2";
  mfa: boolean; // the user has a verified TOTP factor
  recovery?: boolean; // signed in from a password-reset link
}

export function encodeMockSession(s: MockSessionCookie): string {
  return Buffer.from(JSON.stringify(s), "utf8").toString("base64url");
}

export function decodeMockSession(value: string | undefined | null): MockSessionCookie | null {
  if (!value) return null;
  try {
    const json = typeof atob === "function" ? atob(value.replace(/-/g, "+").replace(/_/g, "/")) : Buffer.from(value, "base64url").toString("utf8");
    const s = JSON.parse(json) as MockSessionCookie;
    return typeof s.uid === "string" && (s.aal === "aal1" || s.aal === "aal2") ? s : null;
  } catch {
    return null;
  }
}
