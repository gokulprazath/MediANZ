// Route protection (Next.js 16 "proxy", formerly middleware):
//   - every page except the public ones needs a signed-in user
//   - /staff needs app_metadata.role staff or admin
//   - /clinician and /staff need MFA (aal2) and end after 30 minutes idle;
//     a live demo-login session of a demo account skips the MFA step only
// Screens check the user's role again from their own data; this is the first gate.
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { IDLE_COOKIE, IDLE_LIMIT_MS, isPublicPath, needsAal2 } from "@/lib/auth/constants";
import { DEMO_COOKIE, isDemoSession } from "@/lib/auth/demo";
import { IS_MOCK, SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/env";
import { decodeMockSession, MOCK_SESSION_COOKIE } from "@/lib/mock/session";

interface SessionInfo {
  role: string | null;
  aal: string | null;
  email?: string | null;
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  let response = NextResponse.next({ request });
  let session: SessionInfo | null = null;
  let signOut: () => Promise<void> = async () => {};

  if (IS_MOCK) {
    const s = decodeMockSession(request.cookies.get(MOCK_SESSION_COOKIE)?.value);
    session = s ? { role: s.role, aal: s.aal } : null;
    signOut = async () => {
      response.cookies.delete(MOCK_SESSION_COOKIE);
    };
  } else if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          for (const { name, value } of toSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
        },
      },
    });
    // Verifies the JWT and refreshes the session cookies when needed.
    const { data } = await supabase.auth.getClaims();
    const claims = data?.claims as { app_metadata?: { role?: string }; aal?: string; email?: string } | undefined;
    session = claims ? { role: claims.app_metadata?.role ?? null, aal: claims.aal ?? null, email: claims.email ?? null } : null;
    signOut = async () => {
      await supabase.auth.signOut({ scope: "local" });
    };
  }

  const redirect = (to: string) => {
    const res = NextResponse.redirect(new URL(to, request.url));
    for (const c of response.cookies.getAll()) res.cookies.set(c);
    return res;
  };

  if (isPublicPath(pathname)) return response;

  const next = encodeURIComponent(`${pathname}${search}`);
  if (!session) return redirect(`/login?next=${next}`);

  if ((pathname === "/staff" || pathname.startsWith("/staff/")) && session.role !== "staff" && session.role !== "admin") {
    return redirect("/");
  }

  if (needsAal2(pathname)) {
    const last = Number(request.cookies.get(IDLE_COOKIE)?.value ?? 0);
    if (last && Date.now() - last > IDLE_LIMIT_MS) {
      await signOut();
      const res = redirect("/login?reason=idle");
      res.cookies.delete(IDLE_COOKIE);
      return res;
    }
    const demo = isDemoSession(session.email, request.cookies.get(DEMO_COOKIE)?.value);
    if (session.aal !== "aal2" && !demo) return redirect(`/mfa?next=${next}`);
    response.cookies.set(IDLE_COOKIE, String(Date.now()), { sameSite: "lax", path: "/" });
  }
  return response;
}

export const config = {
  // Everything except API routes, Next.js assets and static files.
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt)$).*)"],
};
