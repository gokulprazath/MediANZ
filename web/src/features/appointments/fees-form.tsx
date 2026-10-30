"use client";
// Fee charged, Medicare rebate and gap on a visit (appointments columns that
// clinicians and staff may update). Gap defaults to fee minus rebate until the
// user types their own value.
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Field } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApi } from "@/lib/data/context";
import { friendlyError } from "@/lib/errors";
import { feesSchema } from "@/lib/validation";
import type { Appointment } from "@/types/db";

const asText = (n: number | null) => (n === null ? "" : n.toFixed(2));

export function defaultGap(fee: string | number, rebate: string | number): string {
  if (fee === "" || fee === null) return "";
  const f = Number(fee);
  const r = rebate === "" || rebate === null ? 0 : Number(rebate);
  if (!Number.isFinite(f) || !Number.isFinite(r)) return "";
  return Math.max(0, Math.round((f - r) * 100) / 100).toFixed(2);
}

export function FeesForm({ appointment, onSaved }: { appointment: Appointment; onSaved?: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  // The gap follows fee - rebate until the user edits it (or it was saved differently).
  const savedGapDiffers =
    appointment.gap_amount !== null && asText(appointment.gap_amount) !== defaultGap(asText(appointment.fee_charged), asText(appointment.medicare_rebate));
  const [gapTouched, setGapTouched] = useState(savedGapDiffers);
  const form = useForm({
    resolver: zodResolver(feesSchema),
    defaultValues: {
      fee_charged: asText(appointment.fee_charged) as string | number,
      medicare_rebate: asText(appointment.medicare_rebate) as string | number,
      gap_amount: asText(appointment.gap_amount) as string | number,
    },
  });
  const { errors, isSubmitting, isDirty } = form.formState;

  const syncGap = () => {
    if (gapTouched) return;
    const { fee_charged, medicare_rebate } = form.getValues();
    form.setValue("gap_amount", defaultGap(fee_charged, medicare_rebate), { shouldDirty: true });
  };

  return (
    <form
      noValidate
      className="grid gap-4 sm:grid-cols-3"
      onSubmit={form.handleSubmit(async (values) => {
        try {
          await api.updateAppointment(appointment.id, values);
          await qc.invalidateQueries({ queryKey: ["appointments"] });
          await qc.invalidateQueries({ queryKey: ["appointment", appointment.id] });
          form.reset(form.getValues());
          toast.success("Fees saved");
          onSaved?.();
        } catch (err) {
          toast.error(friendlyError(err));
        }
      })}
    >
      <Field label="Fee charged ($)" error={errors.fee_charged?.message}>
        <Input type="number" inputMode="decimal" min={0} step="0.01" {...form.register("fee_charged", { onChange: syncGap })} />
      </Field>
      <Field label="Medicare rebate ($)" error={errors.medicare_rebate?.message}>
        <Input type="number" inputMode="decimal" min={0} step="0.01" {...form.register("medicare_rebate", { onChange: syncGap })} />
      </Field>
      <Field label="Gap ($)" error={errors.gap_amount?.message} hint={gapTouched ? "Entered by hand." : "Fee minus rebate, unless you change it."}>
        <Input
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          {...form.register("gap_amount", { onChange: () => setGapTouched(true) })}
        />
      </Field>
      <div className="flex flex-wrap gap-2 sm:col-span-3">
        <Button type="submit" disabled={isSubmitting || !isDirty}>
          {isSubmitting ? "Saving…" : "Save fees"}
        </Button>
        {gapTouched ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setGapTouched(false);
              const { fee_charged, medicare_rebate } = form.getValues();
              form.setValue("gap_amount", defaultGap(fee_charged, medicare_rebate), { shouldDirty: true });
            }}
          >
            Use fee minus rebate
          </Button>
        ) : null}
      </div>
    </form>
  );
}
