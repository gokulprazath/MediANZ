// Where a signed-in user belongs, checked in the order the spec gives (3):
//   1. app_metadata.role staff/admin -> /staff
//   2. a clinicians row for the user  -> /clinician
//   3. a patients row for the user    -> /patient
//   4. signed up as a patient         -> onboarding, otherwise "not set up"
import type { Me } from "@/lib/data/api";

export type Portal = "staff" | "clinician" | "patient";

export function homePathFor(me: Me | null): string {
  if (!me) return "/login";
  if (me.appRole === "staff" || me.appRole === "admin") return "/staff";
  if (me.clinician) return "/clinician";
  if (me.patient) return "/patient";
  if (me.signupRole === "patient") return "/onboarding";
  return "/not-set-up";
}

export function canUsePortal(me: Me | null, portal: Portal): boolean {
  if (!me) return false;
  if (portal === "staff") return me.appRole === "staff" || me.appRole === "admin";
  if (portal === "clinician") return me.clinician !== null;
  return me.patient !== null;
}
