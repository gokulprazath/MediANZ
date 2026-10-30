"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Field } from "@/components/form-field";
import { MockLinkNotice } from "@/components/mock-link-notice";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getAuthClient } from "@/lib/auth/client";
import { friendlyError } from "@/lib/errors";
import { signupSchema } from "@/lib/validation";

export default function SignupPage() {
  const [done, setDone] = useState<{ email: string; link?: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const form = useForm({
    resolver: zodResolver(signupSchema),
    defaultValues: { email: "", password: "", confirm: "" },
  });
  const { errors, isSubmitting } = form.formState;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1 className="text-xl">Create a patient account</h1>
        </CardTitle>
        <CardDescription>
          Clinicians and clinic staff don&apos;t sign up here: their accounts are created by the clinic.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {done ? (
          <div className="grid gap-3" role="status">
            <p>
              We&apos;ve sent a link to <strong>{done.email}</strong>. Open it to confirm your email, then you&apos;ll
              set up your profile.
            </p>
            {done.link ? <MockLinkNotice link={done.link} action="Open the confirmation link" /> : null}
          </div>
        ) : (
          <form
            noValidate
            className="grid gap-4"
            onSubmit={form.handleSubmit(async ({ email, password }) => {
              setError(null);
              try {
                const r = await getAuthClient().signUpPatient(email, password);
                setDone({ email, link: r.mockLink });
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
            <Field label="Password" error={errors.password?.message} hint="At least 8 characters." required>
              <Input type="password" autoComplete="new-password" {...form.register("password")} />
            </Field>
            <Field label="Confirm password" error={errors.confirm?.message} required>
              <Input type="password" autoComplete="new-password" {...form.register("confirm")} />
            </Field>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating account…" : "Create account"}
            </Button>
            <p className="text-sm">
              Already have an account?{" "}
              <Link href="/login" className="text-primary underline underline-offset-2">
                Sign in
              </Link>
            </p>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
