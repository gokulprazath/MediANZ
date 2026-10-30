"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Field } from "@/components/form-field";
import { MockLinkNotice } from "@/components/mock-link-notice";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getAuthClient } from "@/lib/auth/client";
import { friendlyError } from "@/lib/errors";
import { emailSchema } from "@/lib/validation";

export default function ResetPasswordPage() {
  const [sent, setSent] = useState<{ link?: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const form = useForm({ resolver: zodResolver(z.object({ email: emailSchema })), defaultValues: { email: "" } });

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1 className="text-xl">Reset your password</h1>
        </CardTitle>
        <CardDescription>We&apos;ll email you a link to choose a new password.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {sent ? (
          <div className="grid gap-3" role="status">
            <p>If there&apos;s an account for that email, a reset link is on its way.</p>
            {sent.link ? <MockLinkNotice link={sent.link} action="Open the reset link" /> : null}
          </div>
        ) : (
          <form
            noValidate
            className="grid gap-4"
            onSubmit={form.handleSubmit(async ({ email }) => {
              setError(null);
              try {
                const r = await getAuthClient().sendPasswordReset(email);
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
              Send reset link
            </Button>
          </form>
        )}
        <Link href="/login" className="text-sm text-primary underline-offset-2 hover:underline">
          Back to sign in
        </Link>
      </CardContent>
    </Card>
  );
}
