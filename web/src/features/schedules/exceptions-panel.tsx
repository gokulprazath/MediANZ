"use client";
// Leave and extra sessions (schedule_exceptions). Slots update straight away:
// the trigger blocks or unblocks slots for leave and creates extra-session slots.
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { Field } from "@/components/form-field";
import { NativeSelect } from "@/components/native-select";
import { EmptyState, QueryView } from "@/components/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useApi } from "@/lib/data/context";
import { friendlyError } from "@/lib/errors";
import { clinicianName, personName } from "@/lib/format";
import { addDays, formatDateTime, localDate, zonedToUtc } from "@/lib/time";
import { exceptionSchema } from "@/lib/validation";
import type { AppointmentWithRefs, Clinician, Facility, ScheduleException } from "@/types/db";
import { clashingBookings } from "./clashes";

export function ExceptionsPanel({
  clinicians,
  facilities,
  timeZone,
  allowExtraSessions,
  defaultFacilityId,
}: {
  clinicians: Clinician[];
  facilities: Facility[]; // clinics the exception can be for
  timeZone: string; // dates and times are entered in this zone
  allowExtraSessions: boolean;
  defaultFacilityId: string; // "" = all clinics
}) {
  const api = useApi();
  const qc = useQueryClient();
  const ids = clinicians.map((c) => c.id);
  const nowIso = new Date().toISOString();

  const data = useQuery({
    queryKey: ["exceptions", ids.join(",")],
    queryFn: async () => {
      const [exceptions, appointments] = await Promise.all([
        api.listExceptions({ from: nowIso }),
        api.listAppointments({ from: nowIso, statuses: ["booked", "confirmed"] }),
      ]);
      return {
        exceptions: exceptions.filter((e) => ids.includes(e.clinician_id)),
        appointments: appointments.filter((a) => ids.includes(a.clinician_id)),
      };
    },
  });

  const tomorrow = addDays(localDate(new Date(), timeZone), 1);
  const form = useForm({
    resolver: zodResolver(exceptionSchema),
    defaultValues: {
      exception_type: "unavailable" as "unavailable" | "extra_session",
      facility_id: defaultFacilityId,
      start_date: tomorrow,
      start_time: "00:00",
      end_date: addDays(tomorrow, 1),
      end_time: "00:00",
      slot_minutes: "" as string | number,
      reason: "",
    },
  });
  const clinicianField = useForm({ defaultValues: { clinician_id: clinicians.length === 1 ? clinicians[0].id : "" } });
  const type = form.watch("exception_type");
  const { errors, isSubmitting } = form.formState;
  const draft = form.watch();
  const draftClinician = clinicianField.watch("clinician_id");

  const zoneFor = (facilityId: string | null) => facilities.find((f) => f.id === facilityId)?.timezone ?? timeZone;
  const label = (e: ScheduleException) =>
    `${formatDateTime(e.starts_at, zoneFor(e.facility_id))} to ${formatDateTime(e.ends_at, zoneFor(e.facility_id))}`;

  // Clashes for the leave being entered, before it is saved.
  let draftClashes: AppointmentWithRefs[] = [];
  if (data.data && draftClinician && draft.exception_type === "unavailable" && draft.start_date && draft.end_date) {
    try {
      const tz = zoneFor(draft.facility_id || null);
      draftClashes = clashingBookings(
        {
          exception_type: "unavailable",
          clinician_id: draftClinician,
          facility_id: draft.facility_id || null,
          starts_at: zonedToUtc(draft.start_date, draft.start_time, tz).toISOString(),
          ends_at: zonedToUtc(draft.end_date, draft.end_time, tz).toISOString(),
        },
        data.data.appointments,
      );
    } catch {
      draftClashes = [];
    }
  }

  return (
    <div className="grid gap-6">
      <form
        noValidate
        className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={form.handleSubmit(async (v) => {
          const clinicianId = clinicianField.getValues("clinician_id");
          if (!clinicianId) {
            clinicianField.setError("clinician_id", { message: "Choose a clinician" });
            return;
          }
          const tz = zoneFor(v.facility_id || null);
          try {
            await api.addException({
              clinician_id: clinicianId,
              facility_id: v.facility_id || null,
              exception_type: v.exception_type,
              starts_at: zonedToUtc(v.start_date, v.start_time, tz).toISOString(),
              ends_at: zonedToUtc(v.end_date, v.end_time, tz).toISOString(),
              slot_minutes: v.exception_type === "extra_session" ? v.slot_minutes : null,
              reason: v.reason,
            });
            await qc.invalidateQueries({ queryKey: ["exceptions"] });
            await qc.invalidateQueries({ queryKey: ["slots"] });
            await qc.invalidateQueries({ queryKey: ["day-board"] });
            toast.success(v.exception_type === "unavailable" ? "Leave added. Those slots are now blocked." : "Extra session added. Its slots are open for booking.");
            form.reset({ ...form.getValues(), reason: "" });
          } catch (err) {
            toast.error(friendlyError(err));
          }
        })}
      >
        <h3 className="font-semibold sm:col-span-2 lg:col-span-4">{allowExtraSessions ? "Add leave or an extra session" : "Add leave"}</h3>
        {clinicians.length > 1 ? (
          <Field label="Clinician" error={clinicianField.formState.errors.clinician_id?.message} required>
            <NativeSelect {...clinicianField.register("clinician_id")}>
              <option value="">Choose…</option>
              {clinicians.map((c) => (
                <option key={c.id} value={c.id}>
                  {clinicianName(c)}
                </option>
              ))}
            </NativeSelect>
          </Field>
        ) : null}
        {allowExtraSessions ? (
          <Field label="Type">
            <NativeSelect {...form.register("exception_type")}>
              <option value="unavailable">Leave (unavailable)</option>
              <option value="extra_session">Extra session</option>
            </NativeSelect>
          </Field>
        ) : null}
        <Field label="Clinic" error={errors.facility_id?.message}>
          <NativeSelect {...form.register("facility_id")}>
            {type === "unavailable" ? <option value="">All clinics</option> : null}
            {facilities.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {type === "extra_session" ? (
          <Field label="Slot length (minutes)" error={errors.slot_minutes?.message} required>
            <Input type="number" min={5} max={240} {...form.register("slot_minutes")} />
          </Field>
        ) : null}
        <Field label="Starts (date)" error={errors.start_date?.message} required>
          <Input type="date" {...form.register("start_date")} />
        </Field>
        <Field label="Starts (time)" error={errors.start_time?.message} required>
          <Input type="time" {...form.register("start_time")} />
        </Field>
        <Field label="Ends (date)" error={errors.end_date?.message} required>
          <Input type="date" {...form.register("end_date")} />
        </Field>
        <Field label="Ends (time)" error={errors.end_time?.message} required hint={`Times in ${zoneFor(draft.facility_id || null).replace("_", " ")}.`}>
          <Input type="time" {...form.register("end_time")} />
        </Field>
        <Field label="Reason" error={errors.reason?.message} className="sm:col-span-2" hint="Only you and clinic staff can see this.">
          <Input {...form.register("reason")} />
        </Field>
        {draftClashes.length ? (
          <Alert className="sm:col-span-2 lg:col-span-4">
            <AlertTriangle aria-hidden="true" />
            <AlertTitle>
              {draftClashes.length} booking{draftClashes.length === 1 ? "" : "s"} during this leave
            </AlertTitle>
            <AlertDescription>
              Booked appointments are not cancelled automatically. Contact these patients to move them:
              <ul className="mt-1 list-disc pl-5">
                {draftClashes.map((a) => (
                  <li key={a.id}>
                    {formatDateTime(a.scheduled_start, a.facility.timezone)} · {a.patient ? personName(a.patient) : "Patient"}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="sm:col-span-2 lg:col-span-4">
          <Button type="submit" disabled={isSubmitting}>
            {type === "unavailable" ? "Add leave" : "Add extra session"}
          </Button>
        </div>
      </form>

      <QueryView query={data}>
        {({ exceptions, appointments }) =>
          exceptions.length === 0 ? (
            <EmptyState title="No upcoming leave or extra sessions" />
          ) : (
            <ul className="grid gap-2">
              {exceptions.map((e) => {
                const clashes = clashingBookings(e, appointments);
                const c = clinicians.find((x) => x.id === e.clinician_id);
                return (
                  <li key={e.id} className="grid gap-2 rounded-md border p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-medium">
                          {e.exception_type === "unavailable" ? "Leave" : `Extra session (${e.slot_minutes}-minute slots)`}
                          {c && clinicians.length > 1 ? ` · ${clinicianName(c)}` : ""}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {label(e)} · {e.facility_id ? facilities.find((f) => f.id === e.facility_id)?.name ?? "Another clinic" : "All clinics"}
                          {e.reason ? ` · ${e.reason}` : ""}
                        </p>
                      </div>
                      <ConfirmAction
                        trigger="Remove"
                        size="sm"
                        variant="outline"
                        title="Remove this entry?"
                        description={
                          e.exception_type === "unavailable"
                            ? "The blocked slots become available to book again."
                            : "Slots from this session that aren't booked stay open; remove them on the day board if needed."
                        }
                        confirmLabel="Remove"
                        onConfirm={async () => {
                          try {
                            await api.deleteException(e.id);
                            await qc.invalidateQueries({ queryKey: ["exceptions"] });
                            await qc.invalidateQueries({ queryKey: ["day-board"] });
                            toast.success("Removed");
                          } catch (err) {
                            toast.error(friendlyError(err));
                            throw err;
                          }
                        }}
                      />
                    </div>
                    {clashes.length ? (
                      <p className="flex items-start gap-1 text-sm text-warning">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                        <span>
                          Clashes with {clashes.length} booking{clashes.length === 1 ? "" : "s"}:{" "}
                          {clashes
                            .map((a) => `${formatDateTime(a.scheduled_start, a.facility.timezone)}${a.patient ? ` (${personName(a.patient)})` : ""}`)
                            .join("; ")}
                        </span>
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )
        }
      </QueryView>
    </div>
  );
}
