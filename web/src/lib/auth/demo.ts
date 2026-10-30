// Demo accounts for evaluators ("Demo account" on the login page). Each role
// signs in as one sample person at Southbank Family Medical, so a patient's
// booking, the front desk's check-in and the clinician's consult meet in the
// same clinic. Sample data only: no real patients.
import { IS_MOCK } from "@/lib/env";

export type DemoRoleId = "patient" | "clinician" | "receptionist";

export interface DemoRole {
  id: DemoRoleId;
  label: string;
  person: string;
  email: string; // live mode can override with DEMO_<ROLE>_EMAIL
  home: string;
  mfa: boolean; // clinicians and staff need aal2 (mock mode); live demo sessions skip it
  highlights: string[];
}

// HttpOnly cookie /api/demo-login sets. With it, proxy.ts lets the demo
// accounts (and only them) into /clinician and /staff without the MFA step.
export const DEMO_COOKIE = "mz_demo";
export const DEMO_COOKIE_MAX_AGE = 12 * 60 * 60; // seconds

export const DEMO_ROLES: DemoRole[] = [
  {
    id: "patient",
    label: "Patient",
    person: "Olivia Brown",
    email: "olivia.brown@example.com",
    home: "/patient",
    mfa: false,
    highlights: [
      "Find care with AI, costs after Medicare and insurance, and the clinic map",
      "AI assistant: answers from your record, questions for your GP, booking",
      "Appointments, check-in, recording consent, transcripts and feedback",
    ],
  },
  {
    id: "clinician",
    label: "Clinician",
    person: "Dr Asha Rao, Southbank Family Medical",
    email: "asha.rao@example.com",
    home: "/clinician",
    mfa: true,
    highlights: [
      "Today's schedule and consults with consented recording",
      "AI review queue: approve facts and key points, answer patient questions",
      "Leave, schedule changes and patient ratings",
    ],
  },
  {
    id: "receptionist",
    label: "Receptionist",
    person: "Front desk, Southbank Family Medical",
    email: "reception.southbank@example.com",
    home: "/staff",
    mfa: true,
    highlights: [
      "Check patients in and book for them",
      "Clinicians, schedules, fees, claims and patient records",
      "AI operations: agent activity, engines and insurance research drafts",
    ],
  },
];

// Mock mode always offers it; live mode only when the deployment opts in.
export const DEMO_LOGIN = IS_MOCK || process.env.NEXT_PUBLIC_DEMO_LOGIN === "true";

export function demoRole(id: unknown): DemoRole | null {
  return DEMO_ROLES.find((r) => r.id === id) ?? null;
}

const EMAIL_ENV: Record<DemoRoleId, string> = {
  patient: "DEMO_PATIENT_EMAIL",
  clinician: "DEMO_CLINICIAN_EMAIL",
  receptionist: "DEMO_RECEPTIONIST_EMAIL",
};

/** Server only: the account a demo role signs in as (DEMO_<ROLE>_EMAIL overrides). */
export function demoEmail(role: DemoRole): string {
  return (process.env[EMAIL_ENV[role.id]] || role.email).toLowerCase();
}

/** Server only: live demo login is on (DEMO_LOGIN_ENABLED=true). */
export function demoLoginEnabled(): boolean {
  return !IS_MOCK && process.env.DEMO_LOGIN_ENABLED === "true";
}

/** Server only: a demo session may skip MFA (demo cookie and a demo account). */
export function isDemoSession(email: string | null | undefined, cookie: string | undefined): boolean {
  if (!demoLoginEnabled() || !email || !cookie) return false;
  const role = demoRole(cookie);
  return role !== null && demoEmail(role) === email.toLowerCase();
}
