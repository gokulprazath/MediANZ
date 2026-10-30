// Setting the mock session cookie (mock mode only).
import type { NextResponse } from "next/server";
import { IDLE_COOKIE } from "@/lib/auth/constants";
import { encodeMockSession, MOCK_SESSION_COOKIE, type MockSessionCookie } from "./session";
import type { MockUser } from "./users";

const COOKIE_OPTS = { httpOnly: true, sameSite: "lax" as const, path: "/", secure: process.env.NODE_ENV === "production" };

export function sessionFor(user: MockUser, aal: "aal1" | "aal2", recovery = false): MockSessionCookie {
  return { uid: user.id, email: user.email, role: user.app_metadata.role ?? null, aal, mfa: user.mfa_enrolled, recovery };
}

export function setSession(res: NextResponse, s: MockSessionCookie | null) {
  if (s) {
    res.cookies.set(MOCK_SESSION_COOKIE, encodeMockSession(s), COOKIE_OPTS);
    res.cookies.set(IDLE_COOKIE, String(Date.now()), { sameSite: "lax", path: "/" });
  } else {
    res.cookies.delete(MOCK_SESSION_COOKIE);
    res.cookies.delete(IDLE_COOKIE);
  }
  return res;
}

