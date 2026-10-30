import { PortalShell } from "@/components/portal-shell";
import { ConversationProvider } from "@/features/assistant/conversation";
import { FindCareProvider } from "@/features/find-care/context";

const NAV = [
  { href: "/patient", label: "Home", exact: true },
  { href: "/patient/find", label: "Find care" },
  { href: "/patient/assistant", label: "AI assistant" },
  { href: "/patient/appointments", label: "My appointments" },
  { href: "/patient/profile", label: "Profile" },
];

export default function PatientLayout({ children }: { children: React.ReactNode }) {
  return (
    <FindCareProvider>
      <ConversationProvider>
        <PortalShell portal="patient" nav={NAV}>
          {children}
        </PortalShell>
      </ConversationProvider>
    </FindCareProvider>
  );
}
