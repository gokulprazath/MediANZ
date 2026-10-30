// Mock logins, mirroring supabase/seed/02_link_test_logins.sql: the same
// emails, linked to the same sample patients and clinicians. Auth user ids
// follow the backend's fake data (aa000000-...-0001 = Olivia, -0002 = Jack,
// -0011 = Dr Rao).
import type { Uuid } from "@/types/db";

export const MOCK_PASSWORD = "medianz-demo";
export const MOCK_TOTP_CODE = "123456";

export interface MockUser {
  id: Uuid;
  email: string;
  password: string;
  app_metadata: { role?: "staff" | "admin" };
  user_metadata: { signup_role?: string };
  email_confirmed: boolean;
  mfa_enrolled: boolean;
}

export const authId = (n: number) => `aa000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function seedUsers(): MockUser[] {
  const user = (n: number, email: string, extra: Partial<MockUser> = {}): MockUser => ({
    id: authId(n),
    email,
    password: MOCK_PASSWORD,
    app_metadata: {},
    user_metadata: {},
    email_confirmed: true,
    mfa_enrolled: false,
    ...extra,
  });
  return [
    // Patients
    user(1, "olivia.brown@example.com"),
    user(2, "jack.wilson@example.com"),
    user(3, "priya.sharma@example.com"),
    user(6, "lukas.becker@example.com"),
    // Clinicians (TOTP already enrolled; the mock code is 123456)
    user(11, "asha.rao@example.com", { mfa_enrolled: true }),
    user(13, "sophie.williams@example.com", { mfa_enrolled: true }),
    // Staff
    user(21, "reception.southbank@example.com", { app_metadata: { role: "staff" }, mfa_enrolled: true }),
  ];
}

export const DEMO_ACCOUNTS: { email: string; label: string }[] = [
  { email: "olivia.brown@example.com", label: "Patient: history, upcoming visit, approved transcript" },
  { email: "jack.wilson@example.com", label: "Patient: a no-show and a 3-star rating" },
  { email: "priya.sharma@example.com", label: "Patient: visa and insurance changed; claims" },
  { email: "lukas.becker@example.com", label: "Patient: transcript waiting for review" },
  { email: "asha.rao@example.com", label: "Clinician: Southbank Family Medical" },
  { email: "sophie.williams@example.com", label: "Clinician: Paddington GP Clinic" },
  { email: "reception.southbank@example.com", label: "Staff: reception" },
];
