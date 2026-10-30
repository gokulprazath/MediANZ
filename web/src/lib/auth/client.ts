"use client";
// Authentication from the browser. Live mode uses Supabase Auth; mock mode the
// stand-in at /api/mock/auth. Screens only use this interface.
import { IDLE_COOKIE } from "@/lib/auth/constants";
import { IS_MOCK } from "@/lib/env";
import { getBrowserSupabase } from "@/lib/supabase/browser";

export interface MfaStatus {
  currentLevel: string | null; // "aal1" | "aal2"
  nextLevel: string | null;
  factors: { id: string; status: string }[];
}

export interface MfaEnrolment {
  factorId: string;
  secret: string;
  uri: string;
  qrSvg?: string; // Supabase returns an SVG data URL
}

/** In mock mode, the "email" link is returned so the page can show it. */
export interface LinkResult {
  mockLink?: string | null;
}

export interface AuthClient {
  signInWithPassword(email: string, password: string): Promise<void>;
  sendMagicLink(email: string, next: string): Promise<LinkResult>;
  sendPasswordReset(email: string): Promise<LinkResult>;
  updatePassword(password: string): Promise<void>;
  signUpPatient(email: string, password: string): Promise<LinkResult>;
  signOut(): Promise<void>;
  mfaStatus(): Promise<MfaStatus>;
  mfaEnroll(): Promise<MfaEnrolment>;
  mfaVerify(factorId: string, code: string): Promise<void>;
}

export class AuthError extends Error {}

export function markActive(): void {
  document.cookie = `${IDLE_COOKIE}=${Date.now()}; path=/; samesite=lax`;
}

async function mockCall<T>(op: string, body: Record<string, string> = {}): Promise<T> {
  const res = await fetch("/api/mock/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ op, ...body }),
  });
  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: { message: string } };
  if (!res.ok || json.error) throw new AuthError(json.error?.message ?? "Something went wrong");
  return json.data as T;
}

const mockAuth: AuthClient = {
  async signInWithPassword(email, password) {
    await mockCall("signIn", { email, password });
  },
  sendMagicLink: (email, next) => mockCall("magicLink", { email, next }),
  sendPasswordReset: (email) => mockCall("resetPassword", { email }),
  async updatePassword(password) {
    await mockCall("updatePassword", { password });
  },
  signUpPatient: (email, password) => mockCall("signUp", { email, password }),
  async signOut() {
    await mockCall("signOut");
  },
  mfaStatus: () => mockCall("mfaStatus"),
  mfaEnroll: () => mockCall("mfaEnroll"),
  async mfaVerify(_factorId, code) {
    await mockCall("mfaVerify", { code });
  },
};

function check(error: { message: string } | null) {
  if (error) throw new AuthError(error.message);
}

const callbackUrl = (next: string) =>
  `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;

const liveAuth: AuthClient = {
  async signInWithPassword(email, password) {
    const { error } = await getBrowserSupabase().auth.signInWithPassword({ email, password });
    check(error);
  },
  async sendMagicLink(email, next) {
    const { error } = await getBrowserSupabase().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: callbackUrl(next), shouldCreateUser: false },
    });
    check(error);
    return {};
  },
  async sendPasswordReset(email) {
    const { error } = await getBrowserSupabase().auth.resetPasswordForEmail(email, {
      redirectTo: callbackUrl("/update-password"),
    });
    check(error);
    return {};
  },
  async updatePassword(password) {
    const { error } = await getBrowserSupabase().auth.updateUser({ password });
    check(error);
  },
  async signUpPatient(email, password) {
    const { error } = await getBrowserSupabase().auth.signUp({
      email,
      password,
      options: { emailRedirectTo: callbackUrl("/"), data: { signup_role: "patient" } },
    });
    check(error);
    return {};
  },
  async signOut() {
    await getBrowserSupabase().auth.signOut();
  },
  async mfaStatus() {
    const sb = getBrowserSupabase();
    const [aal, factors] = await Promise.all([sb.auth.mfa.getAuthenticatorAssuranceLevel(), sb.auth.mfa.listFactors()]);
    check(aal.error);
    check(factors.error);
    return {
      currentLevel: aal.data?.currentLevel ?? null,
      nextLevel: aal.data?.nextLevel ?? null,
      factors: (factors.data?.totp ?? []).map((f) => ({ id: f.id, status: f.status })),
    };
  },
  async mfaEnroll() {
    const sb = getBrowserSupabase();
    // Remove half-finished enrolments first: Supabase refuses a second unverified factor.
    const listed = await sb.auth.mfa.listFactors();
    for (const f of listed.data?.all ?? []) {
      if (f.factor_type === "totp" && f.status === "unverified") await sb.auth.mfa.unenroll({ factorId: f.id });
    }
    const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: `MediANZ ${Date.now()}` });
    check(error);
    return { factorId: data!.id, secret: data!.totp.secret, uri: data!.totp.uri, qrSvg: data!.totp.qr_code };
  },
  async mfaVerify(factorId, code) {
    const { error } = await getBrowserSupabase().auth.mfa.challengeAndVerify({ factorId, code });
    check(error);
  },
};

export function getAuthClient(): AuthClient {
  return IS_MOCK ? mockAuth : liveAuth;
}
