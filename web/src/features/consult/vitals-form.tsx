"use client";
// Vitals entry (visit_vitals insert). Ranges mirror the SQL checks; BMI is a
// generated column, previewed here as it will be calculated.
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Field } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useApi } from "@/lib/data/context";
import { friendlyError } from "@/lib/errors";
import { bmiPreview, vitalsSchema } from "@/lib/validation";

const EMPTY = {
  temperature_c: "" as string | number,
  spo2_percent: "" as string | number,
  bp_systolic: "" as string | number,
  bp_diastolic: "" as string | number,
  height_cm: "" as string | number,
  weight_kg: "" as string | number,
  notes: "",
};

export function VitalsForm({ appointmentId, patientId }: { appointmentId: string; patientId: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const form = useForm({ resolver: zodResolver(vitalsSchema), defaultValues: EMPTY });
  const { errors, isSubmitting } = form.formState;
  const height = form.watch("height_cm");
  const weight = form.watch("weight_kg");
  const bmi = bmiPreview(height === "" ? null : Number(height), weight === "" ? null : Number(weight));

  const num = (name: keyof typeof EMPTY, label: string, opts: { step?: string; unit: string; hint?: string }) => (
    <Field label={`${label} (${opts.unit})`} error={errors[name]?.message} hint={opts.hint}>
      <Input type="number" inputMode="decimal" step={opts.step ?? "1"} {...form.register(name)} />
    </Field>
  );

  return (
    <form
      noValidate
      aria-label="Record vitals"
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
      onSubmit={form.handleSubmit(async (v) => {
        try {
          await api.addVitals(appointmentId, v);
          await qc.invalidateQueries({ queryKey: ["vitals", appointmentId] });
          await qc.invalidateQueries({ queryKey: ["vitals-latest", patientId] });
          form.reset(EMPTY);
          toast.success("Vitals recorded");
        } catch (err) {
          toast.error(friendlyError(err));
        }
      })}
    >
      {num("temperature_c", "Temperature", { step: "0.1", unit: "°C", hint: "30 to 45" })}
      {num("spo2_percent", "SpO2", { unit: "%", hint: "50 to 100" })}
      {num("bp_systolic", "Systolic BP", { unit: "mmHg", hint: "50 to 300" })}
      {num("bp_diastolic", "Diastolic BP", { unit: "mmHg", hint: "20 to 200" })}
      {num("height_cm", "Height", { step: "0.1", unit: "cm", hint: "30 to 250" })}
      {num("weight_kg", "Weight", { step: "0.1", unit: "kg", hint: "0.5 to 400" })}
      <p className="text-sm sm:col-span-2 lg:col-span-3" aria-live="polite">
        BMI: <strong className="tabular-nums">{bmi ?? "—"}</strong>
        {bmi === null ? <span className="text-muted-foreground"> (enter height and weight)</span> : null}
      </p>
      <Field label="Notes" error={errors.notes?.message} className="sm:col-span-2 lg:col-span-3">
        <Textarea rows={2} maxLength={1000} {...form.register("notes")} />
      </Field>
      <div className="sm:col-span-2 lg:col-span-3">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Record vitals"}
        </Button>
      </div>
    </form>
  );
}
