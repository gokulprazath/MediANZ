"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Field } from "@/components/form-field";
import { NativeSelect } from "@/components/native-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SEX_LABEL } from "@/lib/format";
import { todayUtc } from "@/lib/time";
import { personalSchema } from "@/lib/validation";
import { SEXES, type Patient } from "@/types/db";

export type PersonalValues = z.output<typeof personalSchema>;

export function PersonalForm({
  patient,
  defaults,
  submitLabel = "Save personal details",
  onSubmit,
}: {
  patient?: Patient | null;
  defaults?: Partial<Record<keyof PersonalValues, string>>;
  submitLabel?: string;
  onSubmit: (values: PersonalValues) => Promise<void>;
}) {
  const form = useForm({
    resolver: zodResolver(personalSchema),
    defaultValues: {
      first_name: patient?.first_name ?? defaults?.first_name ?? "",
      last_name: patient?.last_name ?? defaults?.last_name ?? "",
      preferred_name: patient?.preferred_name ?? "",
      date_of_birth: patient?.date_of_birth ?? "",
      sex: (patient?.sex ?? "") as z.input<typeof personalSchema>["sex"],
      gender_identity: patient?.gender_identity ?? "",
      email: patient?.email ?? defaults?.email ?? "",
      phone: patient?.phone ?? "",
    },
  });
  const { errors, isSubmitting, isDirty } = form.formState;

  return (
    <form
      noValidate
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={form.handleSubmit(async (values) => {
        await onSubmit(values);
        form.reset(form.getValues());
      })}
    >
      <Field label="First name" error={errors.first_name?.message} required>
        <Input autoComplete="given-name" {...form.register("first_name")} />
      </Field>
      <Field label="Last name" error={errors.last_name?.message} required>
        <Input autoComplete="family-name" {...form.register("last_name")} />
      </Field>
      <Field label="Preferred name" error={errors.preferred_name?.message} hint="What you'd like us to call you.">
        <Input autoComplete="nickname" {...form.register("preferred_name")} />
      </Field>
      <Field label="Date of birth" error={errors.date_of_birth?.message} required>
        <Input type="date" max={todayUtc()} autoComplete="bday" {...form.register("date_of_birth")} />
      </Field>
      <Field label="Sex" error={errors.sex?.message} hint="As recorded with Medicare.">
        <NativeSelect {...form.register("sex")}>
          <option value="">Not provided</option>
          {SEXES.map((s) => (
            <option key={s} value={s}>
              {SEX_LABEL[s]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Gender identity" error={errors.gender_identity?.message} hint="Optional, in your own words.">
        <Input {...form.register("gender_identity")} />
      </Field>
      <Field label="Email" error={errors.email?.message}>
        <Input type="email" autoComplete="email" {...form.register("email")} />
      </Field>
      <Field label="Mobile phone" error={errors.phone?.message}>
        <Input type="tel" autoComplete="tel" {...form.register("phone")} />
      </Field>
      <div className="sm:col-span-2">
        <Button type="submit" disabled={isSubmitting || (!!patient && !isDirty)}>
          {isSubmitting ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
