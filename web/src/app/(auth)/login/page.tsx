"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Field } from "@/components/form-field";
import { MockLinkNotice } from "@/components/mock-link-notice";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getAuthClient, markActive } from "@/lib/auth/client";
import { safeNext } from "@/lib/auth/constants";
import { IS_MOCK } from "@/lib/env";
import { friendlyError } from "@/lib/errors";
import { DEMO_ACCOUNTS, MOCK_PASSWORD, MOCK_TOTP_CODE } from "@/lib/mock/users";
import { emailSchema, loginSchema } from "@/lib/validation";

const REASONS: Record<string, string> = {
  idle: "You were signed out after 30 minutes without activity.",
  expired: "Your session ended. Please sign in again.",
};

function PasswordForm({ next }: { next: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const form = useForm({ resolver: zodResolver(loginSchema), defaultValues: { email: "", password: "" } });
  const { errors, isSubmitting } = form.formState;

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={form.handleSubmit(async ({ email, password }) => {
        setError(null);
        try {
          await getAuthClient().signInWithPassword(email, password);
          markActive();
          qc.clear();
          router.replace(next);
          router.refresh();
        } catch (err) {
          setError(friendlyError(err));
        }
      })}
    >
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Field label="Email" error={errors.email?.message} required>
        <Input type="email" autoComplete="email" {...form.register("email")} />
      </Field>
      <Field label="Password" error={errors.password?.message} required>
        <Input type="password" autoComplete="current-password" {...form.register("password")} />
      </Field>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

function MagicLinkForm({ next }: { next: string }) {
  const [sent, setSent] = useState<{ link?: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const form = useForm({ resolver: zodResolver(z.object({ email: emailSchema })), defaultValues: { email: "" } });

  if (sent) {
    return (
      <div className="grid gap-3" role="status">
        <p>If there&apos;s an account for that email, a sign-in link is on its way. It works once.</p>
        {sent.link ? <MockLinkNotice link={sent.link} action="Open the sign-in link" /> : null}
      </div>
    );
  }
  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={form.handleSubmit(async ({ email }) => {
        setError(null);
        try {
          const r = await getAuthClient().sendMagicLink(email, next);
          setSent({ link: r.mockLink });
        } catch (err) {
          setError(friendlyError(err));
        }
      })}
    >
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Field label="Email" error={form.formState.errors.email?.message} required>
        <Input type="email" autoComplete="email" {...form.register("email")} />
      </Field>
      <Button type="submit" disabled={form.formState.isSubmitting}>
        Email me a sign-in link
      </Button>
    </form>
  );
}

function LoginInner() {
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const reason = REASONS[params.get("reason") ?? ""];

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl">Sign in</h1>
          </CardTitle>
          <CardDescription>Patients, clinicians and clinic staff all sign in here.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {reason ? (
            <Alert role="status">
              <AlertDescription>{reason}</AlertDescription>
            </Alert>
          ) : null}
          <Tabs defaultValue="password">
            <TabsList className="w-full">
              <TabsTrigger value="password">Password</TabsTrigger>
              <TabsTrigger value="magic">Email link</TabsTrigger>
            </TabsList>
            <TabsContent value="password" className="pt-4">
              <PasswordForm next={next} />
            </TabsContent>
            <TabsContent value="magic" className="pt-4">
              <MagicLinkForm next={next} />
            </TabsContent>
          </Tabs>
          <div className="flex flex-wrap justify-between gap-2 text-sm">
            <Link href="/reset-password" className="text-primary underline-offset-2 hover:underline">
              Forgot your password?
            </Link>
            <Link href="/signup" className="text-primary underline-offset-2 hover:underline">
              New patient? Create an account
            </Link>
          </div>
        </CardContent>
      </Card>
      {IS_MOCK ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="text-base">Mock mode demo accounts</h2>
            </CardTitle>
            <CardDescription>
              Password for all: <code className="font-mono">{MOCK_PASSWORD}</code>. Clinicians and staff then enter the
              authenticator code <code className="font-mono">{MOCK_TOTP_CODE}</code>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-1 text-sm">
              {DEMO_ACCOUNTS.map((a) => (
                <li key={a.email}>
                  <code className="font-mono">{a.email}</code>
                  <span className="text-muted-foreground"> — {a.label}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}
