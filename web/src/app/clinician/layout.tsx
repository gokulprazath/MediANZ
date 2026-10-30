import { PortalShell } from "@/components/portal-shell";

const NAV = [
  { href: "/clinician", label: "Calendar", exact: true },
  { href: "/clinician/ratings", label: "My ratings" },
  { href: "/clinician/leave", label: "My leave" },
];

export default function ClinicianLayout({ children }: { children: React.ReactNode }) {
  return (
    <PortalShell portal="clinician" nav={NAV}>
      {children}
    </PortalShell>
  );
}
