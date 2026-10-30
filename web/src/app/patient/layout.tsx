import { PortalShell } from "@/components/portal-shell";
import { FindCareProvider } from "@/features/find-care/context";

const NAV = [
  { href: "/patient", label: "Home", exact: true },
  { href: "/patient/concierge", label: "AI care finder" },
  { href: "/patient/find", label: "Clinic map" },
  { href: "/patient/assistant", label: "AI assistant" },
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
