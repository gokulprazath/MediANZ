import { PortalShell } from "@/components/portal-shell";
import { FindCareProvider } from "@/features/find-care/context";

const NAV = [
  { href: "/patient", label: "Home", exact: true },
  { href: "/patient/find", label: "Find care" },
  { href: "/patient/appointments", label: "My appointments" },
  { href: "/patient/profile", label: "Profile" },
];

export default function PatientLayout({ children }: { children: React.ReactNode }) {
  return (
    <FindCareProvider>
      <PortalShell portal="patient" nav={NAV}>
        {children}
      </PortalShell>
    </FindCareProvider>
  );
}
