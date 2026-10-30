// Display helpers for the discovery API's ranked clinic cards.
import type { CoverageStatus, FactorScores } from "@/lib/agents/types";

export const COVERAGE_LABEL: Record<CoverageStatus, string> = {
  covered: "Covered by your insurance",
  partially_covered: "Partly covered by your insurance",
  not_covered: "Not covered by your private insurance",
  waiting_period: "Waiting period applies",
  limit_reached: "Yearly limit reached",
  pre_auth_required: "Insurer approval needed first",
  no_policy: "No private insurance on your profile",
  unknown: "Cover not known",
};

export const FACTOR_LABEL: Record<keyof FactorScores, string> = {
  service: "Offers this service",
  insurance: "Your insurance",
  availability: "How soon",
  cost: "Cost to you",
  distance: "Distance",
  preference: "Your preferences",
  rating: "Patient ratings",
};

export const FLAG_LABEL: Record<string, string> = {
  soonest: "Soonest",
  cheapest: "Lowest cost",
  nearest: "Nearest",
};

export const REASON_LABEL: Record<string, string> = {
  MEDICARE_ONLY_SERVICE: "GP visits are paid by Medicare, not private insurance.",
  OUT_OF_HOSPITAL_SPECIALIST: "Private insurance doesn't pay for specialist visits outside hospital.",
  REFERRAL_NEEDED_FOR_REBATE: "You need a GP referral to get the Medicare rebate.",
};

export function moneyText(v: string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(n) : "—";
}
