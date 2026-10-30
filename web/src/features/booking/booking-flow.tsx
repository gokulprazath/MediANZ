"use client";
// Booking (4.4): date strip -> slot grid -> hold_slot (5 minutes) -> confirm
// -> book_slot (or reschedule_appointment). Only the RPCs touch slots.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Timer } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { EmergencyBanner } from "@/components/emergency-banner";
import { Field } from "@/components/form-field";
import { NativeSelect } from "@/components/native-select";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { containsEmergencyWords } from "@/config/emergency";
import { useFindCare } from "@/features/find-care/context";
import { useApi } from "@/lib/data/context";
import { friendlyError } from "@/lib/errors";
import { clinicianName, VISIT_TYPES } from "@/lib/format";
import { formatCountdown, formatDateTime, formatIsoDate, formatTime, localDate, userTimeZone, zoneDiffers } from "@/lib/time";
import { reasonSchema } from "@/lib/validation";
import type { AvailableSlot, Clinician, Facility } from "@/types/db";
import { DateStrip } from "./date-strip";
import { useSlotRealtime } from "./use-slot-realtime";

interface Hold {
  slot: AvailableSlot;
  until: string;
}

function useTick(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function BookingFlow({
  clinician,
  facility,
  patientId,
  rescheduleId,
}: {
  clinician: Clinician;
  facility: Facility;
  patientId: string;
  rescheduleId: string | null;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const router = useRouter();
  const findCare = useFindCare();
  const tz = facility.timezone;
  const firstDate = localDate(new Date(), tz);
  const [week, setWeek] = useState(0);
  const [date, setDate] = useState(firstDate);
  const [hold, setHold] = useState<Hold | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [holding, setHolding] = useState<string | null>(null);
  const [reason, setReason] = useState(findCare.reason);
  const [visitType, setVisitType] = useState("standard");
  const [submitting, setSubmitting] = useState(false);
  const booking = useRef(false);
  const now = useTick(!!hold);

  const slots = useQuery({
    queryKey: ["slots", clinician.id, facility.id, date],
    queryFn: () => api.getAvailableSlots({ date, facilityId: facility.id, clinicianId: clinician.id }),
    refetchInterval: 60_000,
  });

  useSlotRealtime(clinician.id, patientId, hold?.slot.slot_id ?? null, () => {
    if (booking.current) return;
    setHold(null);
    setNotice("Sorry, someone else just booked that time. Please choose another one.");
  });

  const remaining = hold ? Date.parse(hold.until) - now : 0;
  useEffect(() => {
    if (hold && remaining <= 0 && !booking.current) {
      setHold(null);
      setNotice("Your 5-minute hold has ended, so the time was released. Please choose a time again.");
      void qc.invalidateQueries({ queryKey: ["slots", clinician.id] });
    }
  }, [hold, remaining, qc, clinician.id]);

  const choose = async (slot: AvailableSlot) => {
    setNotice(null);
    setHolding(slot.slot_id);
    try {
      const until = await api.holdSlot(slot.slot_id);
      setHold({ slot, until });
    } catch (err) {
      setNotice(friendlyError(err));
      void qc.invalidateQueries({ queryKey: ["slots", clinician.id] });
    } finally {
      setHolding(null);
    }
  };

  const confirm = async () => {
    if (!hold) return;
    const parsed = reasonSchema.safeParse(reason);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0].message);
      return;
    }
    setSubmitting(true);
    booking.current = true;
    try {
      const id = rescheduleId
        ? await api.rescheduleAppointment(rescheduleId, hold.slot.slot_id)
        : await api.bookSlot({
            slotId: hold.slot.slot_id,
            reason: reason.trim() || null,
            visitType,
            channel: "web",
          });
      await qc.invalidateQueries({ queryKey: ["appointments"] });
      toast.success(rescheduleId ? "Appointment moved" : "Appointment booked");
      findCare.setReason("");
      router.push(`/patient/appointments/${id}/confirmed`);
    } catch (err) {
      booking.current = false;
      setSubmitting(false);
      setHold(null);
      setNotice(friendlyError(err));
      void qc.invalidateQueries({ queryKey: ["slots", clinician.id] });
    }
  };

  const showZone = zoneDiffers(new Date(), tz);

  if (hold) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            <h2 className="text-lg">{rescheduleId ? "Confirm the new time" : "Confirm your booking"}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="rounded-md border bg-muted/40 p-3">
            <p className="text-lg font-medium">{formatDateTime(hold.slot.starts_at, tz)}</p>
            <p>
              {clinicianName(clinician)} · {facility.name}
            </p>
          </div>
          <p className="flex items-center gap-2 text-sm" role="timer" aria-live="off">
            <Timer className="size-4" aria-hidden="true" />
            We&apos;re holding this time for you for <strong>{formatCountdown(remaining)}</strong>.
          </p>
          {!rescheduleId ? (
            <>
              {containsEmergencyWords(reason) ? <EmergencyBanner /> : null}
              <Field label="Reason for the visit" hint="Optional. Seen by the clinic, so they can prepare.">
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} />
              </Field>
              <Field label="Visit type" className="max-w-xs">
                <NativeSelect value={visitType} onChange={(e) => setVisitType(e.target.value)}>
                  {VISIT_TYPES.map((v) => (
                    <option key={v.value} value={v.value}>
                      {v.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">The reason and visit type stay the same as your current booking.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={confirm} disabled={submitting}>
              {submitting ? "Booking…" : rescheduleId ? "Move my appointment" : "Book appointment"}
            </Button>
            <Button
              variant="outline"
              disabled={submitting}
              onClick={() => {
                setHold(null);
                void qc.invalidateQueries({ queryKey: ["slots", clinician.id] });
              }}
            >
              Choose a different time
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4">
      {notice ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{notice}</AlertTitle>
        </Alert>
      ) : null}
      <DateStrip
        firstDate={firstDate}
        selected={date}
        week={week}
        onWeekChange={(w) => {
          setWeek(w);
          setDate(new Date(Date.parse(`${firstDate}T00:00:00Z`) + w * 7 * 86_400_000).toISOString().slice(0, 10));
        }}
        onSelect={setDate}
      />
      <section aria-labelledby="slots-title" className="grid gap-3">
        <h2 id="slots-title" className="font-semibold">
          Times on {formatIsoDate(date)}
          {showZone ? <span className="font-normal text-muted-foreground"> (clinic time, {tz.replace("_", " ")})</span> : null}
        </h2>
        {slots.isPending ? <LoadingState label="Loading times…" /> : null}
        {slots.isError ? <ErrorState error={slots.error} onRetry={() => void slots.refetch()} /> : null}
        {slots.data && slots.data.length === 0 ? (
          <EmptyState title="No times available on this day">Try another day in the strip above.</EmptyState>
        ) : null}
        {slots.data && slots.data.length > 0 ? (
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-8" aria-live="polite">
            {slots.data.map((s) => (
              <li key={s.slot_id}>
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={holding !== null}
                  onClick={() => void choose(s)}
                  aria-label={`${formatTime(s.starts_at, tz, { userZone: userTimeZone() })} on ${formatIsoDate(date)}`}
                >
                  {holding === s.slot_id ? "Holding…" : formatTime(s.starts_at, tz, { label: false })}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
