// Mock mode only: what clicking the emailed link would do (verify the email,
// sign in with a magic link, or start a password reset).
import { NextResponse } from "next/server";
import { safeNext } from "@/lib/auth/constants";
import { IS_MOCK } from "@/lib/env";
import { getMockState } from "@/lib/mock/server-state";
import { sessionFor, setSession } from "@/lib/mock/auth-cookies";

export async function GET(request: Request) {
  if (!IS_MOCK) return new NextResponse(null, { status: 404 });
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind");
  const email = (url.searchParams.get("email") ?? "").toLowerCase();
  const user = getMockState().users.find((u) => u.email.toLowerCase() === email);
  if (!user || !["magic", "recovery", "signup"].includes(kind ?? "")) {
    return NextResponse.redirect(new URL("/login?error=link", url.origin));
  }
  if (kind === "signup") user.email_confirmed = true;
  const next = kind === "recovery" ? "/update-password" : safeNext(url.searchParams.get("next"));
  return setSession(NextResponse.redirect(new URL(next, url.origin)), sessionFor(user, "aal1", kind === "recovery"));
}
