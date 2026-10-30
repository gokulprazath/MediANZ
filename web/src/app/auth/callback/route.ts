// Supabase email links (sign-up confirmation, magic link, password reset) land
// here and are exchanged for a cookie session.
import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { safeNext } from "@/lib/auth/constants";
import { IS_MOCK } from "@/lib/env";
import { getServerSupabase } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  if (IS_MOCK) return NextResponse.redirect(new URL(next, url.origin));

  const supabase = await getServerSupabase();
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;

  const { error } = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : tokenHash && type
      ? await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
      : { error: new Error("missing code") };

  if (error) return NextResponse.redirect(new URL("/login?error=link", url.origin));
  const dest = type === "recovery" ? "/update-password" : next;
  return NextResponse.redirect(new URL(dest, url.origin));
}
