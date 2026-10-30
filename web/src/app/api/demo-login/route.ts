// Live mode demo login: signs the browser in as a demo account with a normal
// Supabase session (anon key, so RLS applies; never the service role) and sets
// the demo cookie, with which proxy.ts lets the clinician and receptionist demo
// accounts skip the MFA step. The password is a server-only environment
// variable; nothing is logged.
import { type NextRequest, NextResponse } from "next/server";
import { DEMO_COOKIE, DEMO_COOKIE_MAX_AGE, demoEmail, demoLoginEnabled, demoRole } from "@/lib/auth/demo";
import { getServerSupabase } from "@/lib/supabase/server";

const fail = (status: number, error: string) => NextResponse.json({ error }, { status });

export async function POST(request: NextRequest) {
  // Mock mode signs in through /api/mock/auth; live mode only when opted in.
  if (!demoLoginEnabled()) return fail(404, "demo_disabled");
  const body = (await request.json().catch(() => null)) as { role?: unknown } | null;
  const role = demoRole(body?.role);
  if (!role) return fail(400, "unknown_role");
  const password = process.env.DEMO_PASSWORD;
  if (!password) return fail(503, "demo_not_configured");

  const sb = await getServerSupabase();
  const { error } = await sb.auth.signInWithPassword({ email: demoEmail(role), password });
  if (error) return fail(502, "demo_sign_in_failed");

  const res = NextResponse.json({ next: role.home });
  res.cookies.set(DEMO_COOKIE, role.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: "/",
    maxAge: DEMO_COOKIE_MAX_AGE,
  });
  return res;
}
