"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Field } from "@/components/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getAuthClient } from "@/lib/auth/client";
import { friendlyError } from "@/lib/errors";
import { passwordSchema } from "@/lib/validation";

const schema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Passwords don't match" });

export default function UpdatePasswordPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const form = useForm({ resolver: zodResolver(schema), defaultValues: { password: "", confirm: "" } });
  const { errors, isSubmitting } = form.formState;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1 className="text-xl">Choose a new password</h1>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          className="grid gap-4"
          onSubmit={form.handleSubmit(async ({ password }) => {
            setError(null);
            try {
              await getAuthClient().updatePassword(password);
              toast.success("Password updated");
              router.replace("/");
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
          <Field label="New password" error={errors.password?.message} hint="At least 8 characters." required>
            <Input type="password" autoComplete="new-password" {...form.register("password")} />
          </Field>
          <Field label="Confirm new password" error={errors.confirm?.message} required>
            <Input type="password" autoComplete="new-password" {...form.register("confirm")} />
          </Field>
          <Button type="submit" disabled={isSubmitting}>
            Save password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
