"use client";
// TOTP multi-factor authentication for clinicians and staff (aal2).
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { Field } from "@/components/form-field";
import { SignOutButton } from "@/components/portal-shell";
import { ErrorState, LoadingState } from "@/components/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getAuthClient, markActive, type MfaEnrolment } from "@/lib/auth/client";
import { safeNext } from "@/lib/auth/constants";
import { IS_MOCK } from "@/lib/env";
import { friendlyError } from "@/lib/errors";
import { MOCK_TOTP_CODE } from "@/lib/mock/users";
import { totpSchema } from "@/lib/validation";

function Enrolment({ onReady }: { onReady: (e: MfaEnrolment) => void }) {
  const enrol = useQuery({ queryKey: ["mfa-enrol"], queryFn: () => getAuthClient().mfaEnroll(), staleTime: Infinity, gcTime: 0 });
  const [generatedQr, setGeneratedQr] = useState<string | null>(null);
  const qr = enrol.data?.qrSvg ?? generatedQr;
  useEffect(() => {
    if (!enrol.data) return;
    onReady(enrol.data);
    if (!enrol.data.qrSvg) void QRCode.toDataURL(enrol.data.uri, { margin: 1, width: 192 }).then(setGeneratedQr);
  }, [enrol.data, onReady]);

  if (enrol.isPending) return <LoadingState label="Preparing your authenticator set-up…" />;
  if (enrol.isError) return <ErrorState error={enrol.error} onRetry={() => void enrol.refetch()} />;
  return (
    <div className="grid gap-3">
      <p>Scan this code with an authenticator app (for example Google Authenticator or Microsoft Authenticator).</p>
      {qr ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={qr} alt="QR code for your authenticator app" width={192} height={192} className="rounded border bg-white p-2" />
      ) : null}
      <p className="text-sm">
        Can&apos;t scan it? Enter this key in the app: <code className="font-mono break-all">{enrol.data.secret}</code>
      </p>
    </div>
  );
}

function MfaInner() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  const status = useQuery({ queryKey: ["mfa-status"], queryFn: () => getAuthClient().mfaStatus(), gcTime: 0 });
  const [enrolment, setEnrolment] = useState<MfaEnrolment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const form = useForm({ resolver: zodResolver(totpSchema), defaultValues: { code: "" } });

  useEffect(() => {
    if (status.data?.currentLevel === "aal2") router.replace(next);
  }, [status.data, next, router]);

  if (status.isPending) return <LoadingState />;
  if (status.isError) return <ErrorState error={status.error} onRetry={() => void status.refetch()} />;

  const verified = status.data.factors.find((f) => f.status === "verified");
  const factorId = verified?.id ?? enrolment?.factorId;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1 className="text-xl">{verified ? "Enter your authenticator code" : "Set up two-step sign-in"}</h1>
        </CardTitle>
        <CardDescription>Clinician and staff accounts need a code from an authenticator app every time you sign in.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!verified ? <Enrolment onReady={setEnrolment} /> : null}
        {IS_MOCK ? (
          <Alert>
            <AlertDescription>
              Mock mode: the code is <code className="font-mono">{MOCK_TOTP_CODE}</code>.
            </AlertDescription>
          </Alert>
        ) : null}
        <form
          noValidate
          className="grid gap-4"
          onSubmit={form.handleSubmit(async ({ code }) => {
            if (!factorId) return;
            setError(null);
            try {
              await getAuthClient().mfaVerify(factorId, code);
              markActive();
              // Full load: the client router may have cached the pre-MFA redirect for this path.
              window.location.replace(next);
            } catch (err) {
              setError(friendlyError(err));
              form.reset({ code: "" });
            }
          })}
        >
          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <Field label="6-digit code" error={form.formState.errors.code?.message} required>
            <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} {...form.register("code")} />
          </Field>
          <Button type="submit" disabled={!factorId || form.formState.isSubmitting}>
            Verify
          </Button>
        </form>
        <SignOutButton className="justify-self-start" />
      </CardContent>
    </Card>
  );
}

export default function MfaPage() {
  return (
    <Suspense>
      <MfaInner />
    </Suspense>
  );
}
