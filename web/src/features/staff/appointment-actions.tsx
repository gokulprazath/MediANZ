"use client";
// Front-desk status changes: check in (arrival time is set by the trigger),
// mark no-show, cancel. The appointments trigger enforces which changes are allowed.
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { Field } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useApi } from "@/lib/data/context";
import { friendlyError } from "@/lib/errors";
import { personName } from "@/lib/format";
import type { AppointmentStatus, AppointmentWithRefs } from "@/types/db";

export function useStatusChange() {
  const api = useApi();
  const qc = useQueryClient();
  return async (a: AppointmentWithRefs, status: AppointmentStatus, message: string) => {
    try {
      await api.updateAppointment(a.id, { status });
      await qc.invalidateQueries({ queryKey: ["appointments"] });
      await qc.invalidateQueries({ queryKey: ["appointment", a.id] });
      toast.success(message);
    } catch (err) {
      toast.error(friendlyError(err));
      throw err;
    }
  };
}

export function FrontDeskActions({ a, now = new Date() }: { a: AppointmentWithRefs; now?: Date }) {
  const api = useApi();
  const qc = useQueryClient();
  const change = useStatusChange();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const name = a.patient ? personName(a.patient) : "the patient";
  const open = a.status === "booked" || a.status === "confirmed";
  const started = new Date(a.scheduled_start) < now;

  return (
    <div className="flex flex-wrap gap-2">
      {open ? (
        <Button
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await change(a, "checked_in", `${name} checked in`).catch(() => undefined);
            setBusy(false);
          }}
        >
          Check in
        </Button>
      ) : null}
      {open && started ? (
        <ConfirmAction
          trigger="No-show"
          size="sm"
          variant="outline"
          title={`Mark ${name} as did not attend?`}
          description="This can't be undone. Use it only when the patient didn't arrive."
          confirmLabel="Mark no-show"
          onConfirm={() => change(a, "no_show", "Marked as did not attend")}
        />
      ) : null}
      {open || a.status === "checked_in" ? (
        <ConfirmAction
          trigger="Cancel"
          size="sm"
          variant="ghost"
          title={`Cancel ${name}'s appointment?`}
          description="The time will become available to book again if it's still in the future."
          confirmLabel="Cancel appointment"
          onConfirm={async () => {
            try {
              await api.cancelAppointment(a.id, reason.trim() || null);
              await qc.invalidateQueries({ queryKey: ["appointments"] });
              toast.success("Appointment cancelled");
            } catch (err) {
              toast.error(friendlyError(err));
              throw err;
            }
          }}
        >
          <Field label="Reason (optional)">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} />
          </Field>
        </ConfirmAction>
      ) : null}
    </div>
  );
}
