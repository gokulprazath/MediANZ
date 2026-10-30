"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { Field } from "@/components/form-field";
import { NativeSelect } from "@/components/native-select";
import { EmptyState, PageHeader, QueryView } from "@/components/states";
import { SlotStatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ExceptionsPanel } from "@/features/schedules/exceptions-panel";
import { RequireClinic } from "@/features/staff/clinic-context";
import { clinicToday, dayRange } from "@/lib/clinic-day";
import { useApi } from "@/lib/data/context";
import { friendlyError } from "@/lib/errors";
import { clinicianName } from "@/lib/format";
import { validOn } from "@/lib/history";
import { addDays, formatIsoDate, formatTime } from "@/lib/time";
import { scheduleSchema } from "@/lib/validation";
import type { AppointmentSlot, Clinician, Facility } from "@/types/db";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function useClinicClinicians(clinic: Facility) {
  const api = useApi();
  return useQuery({
    queryKey: ["clinic-clinicians", clinic.id],
    queryFn: async () => {
      const [affs, all] = await Promise.all([api.listAffiliations(), api.listClinicians()]);
      const today = clinicToday(clinic.timezone);
      const ids = new Set(affs.filter((a) => a.facility_id === clinic.id && validOn(a, today)).map((a) => a.clinician_id));
      return all.filter((c) => ids.has(c.id));
    },
  });
}

function SlotRow({ slot, tz }: { slot: AppointmentSlot; tz: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const toggle = async (blocked: boolean) => {
    setBusy(true);
    try {
      await api.setSlotBlocked(slot.id, blocked);
      await qc.invalidateQueries({ queryKey: ["day-board"] });
      toast.success(blocked ? "Slot blocked" : "Slot unblocked");
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex items-center justify-between gap-2 py-1.5">
      <span className="flex items-center gap-2">
        <span className="w-20 tabular-nums">{formatTime(slot.starts_at, tz, { label: false })}</span>
        <SlotStatusBadge status={slot.status} />
      </span>
      {slot.status === "available" ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void toggle(true)}>
          Block
        </Button>
      ) : slot.status === "blocked" ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void toggle(false)}>
          Unblock
        </Button>
      ) : (
        <span className="text-xs text-muted-foreground">{slot.status === "booked" ? "Booked — can't change here" : "Being booked"}</span>
      )}
    </li>
  );
}

function DayBoard({ clinic, clinicians }: { clinic: Facility; clinicians: Clinician[] }) {
  const api = useApi();
  const tz = clinic.timezone;
  const [date, setDate] = useState(clinicToday(tz));
  const range = dayRange(date, tz);
  const slots = useQuery({
    queryKey: ["day-board", clinic.id, date],
    queryFn: () => api.listSlots({ facilityId: clinic.id, from: range.from, to: range.to }),
    refetchInterval: 15_000,
  });
  return (
    <div className="grid gap-4">
      <Field label="Day" className="w-44">
        <Input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
      </Field>
      <p className="text-sm text-muted-foreground">
        Block or unblock single slots. Booked slots are never changed here; cancel or move the appointment instead. Leave
        re-blocks its slots whenever leave changes.
      </p>
      <QueryView query={slots}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState title={`No slots on ${formatIsoDate(date)}`} />
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {clinicians
                .filter((c) => rows.some((s) => s.clinician_id === c.id))
                .map((c) => (
                  <Card key={c.id}>
                    <CardHeader>
                      <CardTitle>
                        <h3 className="text-base">{clinicianName(c)}</h3>
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ul className="divide-y">
                        {rows
                          .filter((s) => s.clinician_id === c.id)
                          .map((s) => (
                            <SlotRow key={s.id} slot={s} tz={tz} />
                          ))}
                      </ul>
                    </CardContent>
                  </Card>
                ))}
            </div>
          )
        }
      </QueryView>
    </div>
  );
}

function WeeklySchedule({ clinic, clinicians }: { clinic: Facility; clinicians: Clinician[] }) {
  const api = useApi();
  const qc = useQueryClient();
  const today = clinicToday(clinic.timezone);
  const schedules = useQuery({
    queryKey: ["schedules", clinic.id],
    queryFn: () => api.listSchedules({ facilityId: clinic.id }),
  });
  const form = useForm({
    resolver: zodResolver(scheduleSchema),
    defaultValues: {
      clinician_id: "",
      weekday: 1 as number,
      start_time: "09:00",
      end_time: "12:00",
      slot_minutes: 15 as number,
      valid_from: addDays(today, 1),
    },
  });
  const { errors, isSubmitting } = form.formState;

  return (
    <div className="grid gap-6">
      <Alert>
        <AlertDescription>
          Changes to the weekly schedule take effect when the nightly job creates slots: <strong>new slots appear overnight</strong>.
          Use leave or extra sessions for changes that need to show straight away.
        </AlertDescription>
      </Alert>
      <form
        noValidate
        className="grid gap-4 rounded-lg border p-4 sm:grid-cols-3 lg:grid-cols-6"
        onSubmit={form.handleSubmit(async (v) => {
          try {
            await api.addSchedule({ ...v, facility_id: clinic.id });
            await qc.invalidateQueries({ queryKey: ["schedules", clinic.id] });
            toast.success("Weekly session added. New slots appear overnight.");
          } catch (err) {
            toast.error(friendlyError(err));
          }
        })}
      >
        <h3 className="font-semibold sm:col-span-3 lg:col-span-6">Add a weekly session</h3>
        <Field label="Clinician" error={errors.clinician_id?.message} required className="lg:col-span-2">
          <NativeSelect {...form.register("clinician_id")}>
            <option value="">Choose…</option>
            {clinicians.map((c) => (
              <option key={c.id} value={c.id}>
                {clinicianName(c)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Day" error={errors.weekday?.message}>
          <NativeSelect {...form.register("weekday")}>
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i + 1}>
                {d}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Starts" error={errors.start_time?.message}>
          <Input type="time" {...form.register("start_time")} />
        </Field>
        <Field label="Ends" error={errors.end_time?.message}>
          <Input type="time" {...form.register("end_time")} />
        </Field>
        <Field label="Slot (min)" error={errors.slot_minutes?.message}>
          <Input type="number" min={5} max={240} {...form.register("slot_minutes")} />
        </Field>
        <Field label="From" error={errors.valid_from?.message}>
          <Input type="date" {...form.register("valid_from")} />
        </Field>
        <div className="sm:col-span-3 lg:col-span-6">
          <Button type="submit" disabled={isSubmitting}>
            Add session
          </Button>
        </div>
      </form>

      <QueryView query={schedules}>
        {(rows) => {
          const live = rows.filter((s) => s.valid_to === null || s.valid_to > today);
          return clinicians.map((c) => {
            const mine = live.filter((s) => s.clinician_id === c.id);
            if (!mine.length) return null;
            return (
              <section key={c.id} aria-labelledby={`sched-${c.id}`} className="grid gap-2">
                <h3 id={`sched-${c.id}`} className="font-semibold">
                  {clinicianName(c)}
                </h3>
                <ul className="grid gap-1">
                  {mine.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
                      <span>
                        {WEEKDAYS[s.weekday - 1]} {s.start_time.slice(0, 5)}–{s.end_time.slice(0, 5)} · {s.slot_minutes}-minute slots
                        <span className="text-sm text-muted-foreground">
                          {" "}
                          · from {formatIsoDate(s.valid_from)}
                          {s.valid_to ? ` to ${formatIsoDate(s.valid_to)}` : ""}
                        </span>
                      </span>
                      {s.valid_to === null ? (
                        <ConfirmAction
                          trigger="End"
                          size="sm"
                          variant="outline"
                          title="End this weekly session?"
                          description={`No new slots are made after ${formatIsoDate(addDays(today, 1) > s.valid_from ? addDays(today, 1) : addDays(s.valid_from, 1))}. Slots already created stay until you block them.`}
                          confirmLabel="End session"
                          onConfirm={async () => {
                            try {
                              const end = addDays(today, 1) > s.valid_from ? addDays(today, 1) : addDays(s.valid_from, 1);
                              await api.endSchedule(s.id, end);
                              await qc.invalidateQueries({ queryKey: ["schedules", clinic.id] });
                              toast.success("Session ended");
                            } catch (err) {
                              toast.error(friendlyError(err));
                              throw err;
                            }
                          }}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            );
          });
        }}
      </QueryView>
    </div>
  );
}

function Schedules({ clinic }: { clinic: Facility }) {
  const clinicians = useClinicClinicians(clinic);
  return (
    <>
      <PageHeader title="Slots and schedules" description={clinic.name} />
      <QueryView query={clinicians}>
        {(list) => (
          <Tabs defaultValue="day">
            <TabsList>
              <TabsTrigger value="day">Day board</TabsTrigger>
              <TabsTrigger value="leave">Leave and extra sessions</TabsTrigger>
              <TabsTrigger value="weekly">Weekly schedule</TabsTrigger>
            </TabsList>
            <TabsContent value="day" className="pt-4">
              <DayBoard clinic={clinic} clinicians={list} />
            </TabsContent>
            <TabsContent value="leave" className="pt-4">
              <ExceptionsPanel
                clinicians={list}
                facilities={[clinic]}
                timeZone={clinic.timezone}
                allowExtraSessions
                defaultFacilityId={clinic.id}
              />
            </TabsContent>
            <TabsContent value="weekly" className="pt-4">
              <WeeklySchedule clinic={clinic} clinicians={list} />
            </TabsContent>
          </Tabs>
        )}
      </QueryView>
    </>
  );
}

export default function SchedulesPage() {
  return <RequireClinic>{(clinic) => <Schedules clinic={clinic} />}</RequireClinic>;
}
