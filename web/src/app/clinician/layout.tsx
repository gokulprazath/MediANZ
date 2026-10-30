"use client";
import { PortalShell } from "@/components/portal-shell";
import { reviewCount, useReviewData } from "@/features/review/review-queue";
import { useMe } from "@/lib/hooks/use-me";

export default function ClinicianLayout({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const review = useReviewData(me.data?.clinician?.id ?? "");
  const count = review.data ? reviewCount(review.data) : 0;
  const nav = [
    { href: "/clinician", label: "Calendar", exact: true },
    { href: "/clinician/review", label: count ? `Review queue (${count})` : "Review queue" },
    { href: "/clinician/ratings", label: "My ratings" },
    { href: "/clinician/leave", label: "My leave" },
  ];
  return (
    <PortalShell portal="clinician" nav={nav}>
      {children}
    </PortalShell>
  );
}
