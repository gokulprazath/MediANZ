import { Phone } from "lucide-react";
import { EMERGENCY_CONTACTS } from "@/config/emergency";

export function EmergencyBanner() {
  return (
    <div role="alert" className="rounded-lg border-2 border-destructive bg-danger-soft p-4">
      <p className="text-lg font-semibold text-destructive">If this is an emergency, call 000 now.</p>
      <p className="mt-1">This app can&apos;t help in an emergency. Please get help straight away:</p>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {Object.values(EMERGENCY_CONTACTS).map((c) => (
          <li key={c.number}>
            <a
              href={`tel:${c.number.replace(/\s/g, "")}`}
              className="flex items-center gap-2 rounded-md bg-background px-3 py-2 font-medium underline-offset-2 hover:underline"
            >
              <Phone className="size-4" aria-hidden="true" />
              <span>
                {c.number} <span className="font-normal text-muted-foreground">({c.label})</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
