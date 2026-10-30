"use client";
import { PortalShell } from "@/components/portal-shell";
import { ClinicPicker, ClinicProvider } from "@/features/staff/clinic-context";

const NAV = [
  { href: "/staff", label: "Front desk", exact: true },
  { href: "/staff/book", label: "Book for a patient" },
  { href: "/staff/patients/new", label: "New patient" },
  { href: "/staff/schedules", label: "Slots and schedules" },
  { href: "/staff/clinicians", label: "Clinicians" },
  { href: "/staff/visits", label: "Visits, fees and claims" },
  { href: "/staff/ratings", label: "Ratings" },
  { href: "/staff/operations", label: "AI operations" },
];

function StaffBanner() {
  return (
    <div className="border-b bg-muted/60">
      <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-3 px-4 py-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          <strong className="text-foreground">Part A:</strong> staff accounts can see every clinic, because the
          backend&apos;s staff role is global. Screens are filtered by the clinic you pick; per-clinic security comes in
          Part B.
        </p>
        <ClinicPicker className="w-72" />
      </div>
    </div>
  );
}

export default function StaffLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClinicProvider>
      <PortalShell portal="staff" nav={NAV} banner={<StaffBanner />}>
        {children}
      </PortalShell>
    </ClinicProvider>
  );
}
