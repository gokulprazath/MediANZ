"use client";
import { useQueryClient } from "@tanstack/react-query";
import { HeartPulse, LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { getAuthClient } from "@/lib/auth/client";
import type { Me } from "@/lib/data/api";
import { useIdleTimeout } from "@/lib/hooks/use-idle-timeout";
import { useMe } from "@/lib/hooks/use-me";
import { canUsePortal, homePathFor, type Portal } from "@/lib/roles";
import { cn } from "@/lib/utils";

export interface NavItem {
  href: string;
  label: string;
  exact?: boolean;
}

const PORTAL_LABEL: Record<Portal, string> = {
  patient: "Patient",
  clinician: "Clinician",
  staff: "Clinic staff",
};

export function SignOutButton({ className }: { className?: string }) {
  const qc = useQueryClient();
  const router = useRouter();
  return (
    <Button
      variant="ghost"
      size="sm"
      className={className}
      onClick={async () => {
        await getAuthClient().signOut();
        qc.clear();
        router.replace("/login");
        router.refresh();
      }}
    >
      <LogOut aria-hidden="true" />
      Sign out
    </Button>
  );
}

function displayName(me: Me): string {
  if (me.clinician) return `${me.clinician.first_name} ${me.clinician.last_name}`;
  if (me.patient) return me.patient.preferred_name ?? me.patient.first_name;
  return me.email ?? "";
}

export function PortalShell({
  portal,
  nav,
  banner,
  children,
}: {
  portal: Portal;
  nav: NavItem[];
  banner?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const me = useMe();
  const allowed = me.data ? canUsePortal(me.data, portal) : false;
  useIdleTimeout(portal !== "patient" && allowed);

  useEffect(() => {
    if (me.isSuccess && !allowed) router.replace(homePathFor(me.data));
  }, [me.isSuccess, me.data, allowed, router]);

  return (
    <div className="flex flex-1 flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-background focus:px-3 focus:py-2"
      >
        Skip to main content
      </a>
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <Link href={`/${portal}`} className="flex items-center gap-2 font-semibold">
            <HeartPulse className="size-5 text-primary" aria-hidden="true" />
            <span>MediANZ</span>
            <span className="rounded bg-secondary px-1.5 py-0.5 text-xs font-medium text-secondary-foreground">
              {PORTAL_LABEL[portal]}
            </span>
          </Link>
          <div className="flex items-center gap-2">
            {me.data ? <span className="hidden text-sm text-muted-foreground sm:inline">{displayName(me.data)}</span> : null}
            <SignOutButton />
          </div>
        </div>
        <nav aria-label={`${PORTAL_LABEL[portal]} navigation`} className="mx-auto max-w-6xl overflow-x-auto px-2">
          <ul className="flex gap-1 pb-2">
            {nav.map((item) => {
              const active = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "block rounded-md px-3 py-1.5 text-sm whitespace-nowrap hover:bg-muted",
                      active && "bg-secondary font-medium text-secondary-foreground",
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>
      {banner}
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {me.isPending || !allowed ? <LoadingState /> : children}
      </main>
    </div>
  );
}
