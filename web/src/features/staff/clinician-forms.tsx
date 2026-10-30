"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Field } from "@/components/form-field";
import { NativeSelect } from "@/components/native-select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CLINICIAN_TYPE_LABEL, SEX_LABEL } from "@/lib/format";
import { clinicianSchema } from "@/lib/validation";
import { CLINICIAN_TYPES, SEXES, type Clinician } from "@/types/db";

export const LOGIN_LINK_NOTE =
  "Logins are linked by the clinic administrator: create the user in the Supabase dashboard, then run supabase/seed/02_link_test_logins.sql (it matches by email).";

export type ClinicianValues = z.output<typeof clinicianSchema>;

export function ClinicianProfileForm({
  clinician,
  submitLabel,
  onSubmit,
}: {
  clinician?: Clinician;
  submitLabel: string;
  onSubmit: (v: ClinicianValues) => Promise<void>;
}) {
  const form = useForm({
    resolver: zodResolver(clinicianSchema),
    defaultValues: {
      first_name: clinician?.first_name ?? "",
      last_name: clinician?.last_name ?? "",
      sex: (clinician?.sex ?? "") as z.input<typeof clinicianSchema>["sex"],
      email: clinician?.email ?? "",
      phone: clinician?.phone ?? "",
      clinician_type: clinician?.clinician_type ?? "gp",
      specialty: clinician?.specialty ?? "",
      ahpra_registration_number: clinician?.ahpra_registration_number ?? "",
      is_active: clinician?.is_active ?? true,
    },
  });
  const { errors, isSubmitting } = form.formState;
  return (
    <form
      noValidate
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={form.handleSubmit(async (v) => {
        await onSubmit(v);
        form.reset(form.getValues());
      })}
    >
      <Field label="First name" error={errors.first_name?.message} required>
        <Input {...form.register("first_name")} />
      </Field>
      <Field label="Last name" error={errors.last_name?.message} required>
        <Input {...form.register("last_name")} />
      </Field>
      <Field label="Type" error={errors.clinician_type?.message}>
        <NativeSelect {...form.register("clinician_type")}>
          {CLINICIAN_TYPES.map((t) => (
            <option key={t} value={t}>
              {CLINICIAN_TYPE_LABEL[t]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Specialty" error={errors.specialty?.message}>
        <Input {...form.register("specialty")} />
      </Field>
      <Field label="AHPRA registration number" error={errors.ahpra_registration_number?.message} hint="e.g. MED0001234567">
        <Input autoComplete="off" {...form.register("ahpra_registration_number")} />
      </Field>
      <Field label="Sex" error={errors.sex?.message}>
        <NativeSelect {...form.register("sex")}>
          <option value="">Not provided</option>
          {SEXES.map((s) => (
            <option key={s} value={s}>
              {SEX_LABEL[s]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Email" error={errors.email?.message} hint="Used to link their login (done in the Supabase dashboard).">
        <Input type="email" {...form.register("email")} />
      </Field>
      <Field label="Phone" error={errors.phone?.message}>
        <Input type="tel" {...form.register("phone")} />
      </Field>
      <div className="flex items-center gap-2">
        <Checkbox
          id="clinician-active"
          checked={form.watch("is_active")}
          onCheckedChange={(v) => form.setValue("is_active", v === true, { shouldDirty: true })}
        />
        <Label htmlFor="clinician-active">Active (shown to patients, gets new slots)</Label>
      </div>
      <div className="sm:col-span-2">
        <Button type="submit" disabled={isSubmitting}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
