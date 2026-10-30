// Mock mode only: a stand-in for Supabase Auth (password, magic link, reset,
// sign-up with verification, TOTP MFA). Emails are not sent: the "link" is
// returned to the page so it can be opened directly.
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { IS_MOCK } from "@/lib/env";
import { getMockState } from "@/lib/mock/server-state";
import { sessionFor, setSession } from "@/lib/mock/auth-cookies";
import { decodeMockSession, MOCK_SESSION_COOKIE } from "@/lib/mock/session";
import { authId, MOCK_TOTP_CODE, type MockUser } from "@/lib/mock/users";

function err(message: string, status = 400) {
  return NextResponse.json({ error: { message } }, { status });
}

const findUser = (email: string) =>
  getMockState().users.find((u) => u.email.toLowerCase() === email.trim().toLowerCase()) ?? null;

export async function POST(request: Request) {
  if (!IS_MOCK) return new NextResponse(null, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as Record<string, string>;
  const session = decodeMockSession((await cookies()).get(MOCK_SESSION_COOKIE)?.value);
  const state = getMockState();
  const me = session ? (state.users.find((u) => u.id === session.uid) ?? null) : null;
  const origin = new URL(request.url).origin;
  const link = (kind: string, email: string, next = "/") =>
    `${origin}/api/mock/auth/link?kind=${kind}&email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}`;

  switch (body.op) {
    case "session":
      return NextResponse.json({ data: session && me ? { ...sessionFor(me, session.aal, session.recovery) } : null });

    case "signIn": {
      const user = findUser(body.email ?? "");
      if (!user || user.password !== body.password) return err("Invalid login credentials");
      if (!user.email_confirmed) return err("Email not confirmed");
      return setSession(NextResponse.json({ data: { ok: true } }), sessionFor(user, "aal1"));
    }

    case "magicLink": {
      const user = findUser(body.email ?? "");
      // Like Supabase with shouldCreateUser: false, the reply does not reveal whether the email exists.
      return NextResponse.json({ data: { mockLink: user ? link("magic", user.email, body.next) : null } });
    }

    case "resetPassword": {
      const user = findUser(body.email ?? "");
      return NextResponse.json({ data: { mockLink: user ? link("recovery", user.email, "/update-password") : null } });
    }

    case "updatePassword": {
      if (!me) return err("Auth session missing!", 401);
      if ((body.password ?? "").length < 8) return err("Password should be at least 8 characters.");
      me.password = body.password;
      return setSession(NextResponse.json({ data: { ok: true } }), sessionFor(me, session!.aal));
    }

    case "signUp": {
      const email = (body.email ?? "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err("Unable to validate email address: invalid format");
      if ((body.password ?? "").length < 8) return err("Password should be at least 8 characters.");
      if (findUser(email)) return err("User already registered");
      const user: MockUser = {
        id: authId(100 + state.users.length),
        email,
        password: body.password,
        app_metadata: {},
        user_metadata: { signup_role: "patient" },
        email_confirmed: false,
        mfa_enrolled: false,
      };
      state.users.push(user);
      return NextResponse.json({ data: { mockLink: link("signup", email, "/") } });
    }

    case "signOut":
      return setSession(NextResponse.json({ data: { ok: true } }), null);

    case "mfaStatus": {
      if (!me || !session) return err("Auth session missing!", 401);
      return NextResponse.json({
        data: {
          currentLevel: session.aal,
          nextLevel: me.mfa_enrolled ? "aal2" : "aal1",
          factors: me.mfa_enrolled ? [{ id: `totp-${me.id}`, status: "verified" }] : [],
        },
      });
    }

    case "mfaEnroll": {
      if (!me) return err("Auth session missing!", 401);
      return NextResponse.json({
        data: {
          factorId: `totp-${me.id}`,
          secret: "MOCKMOCKMOCKMOCK",
          uri: `otpauth://totp/MediANZ:${encodeURIComponent(me.email)}?secret=MOCKMOCKMOCKMOCK&issuer=MediANZ`,
        },
      });
    }

    case "mfaVerify": {
      if (!me || !session) return err("Auth session missing!", 401);
      if (body.code !== MOCK_TOTP_CODE) return err("Invalid TOTP code entered");
      me.mfa_enrolled = true;
      return setSession(NextResponse.json({ data: { ok: true } }), sessionFor(me, "aal2"));
    }

    default:
      return err("Unknown operation");
  }
}
