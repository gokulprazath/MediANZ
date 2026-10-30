"use client";
// Clinician calendar (5.1): own appointments (RLS), day/week/month, coloured by
// status with the status also in the text; today by default; polled every 30 s.
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/react/daygrid";
import enAuLocale from "@fullcalendar/react/locales/en-au";
import classicThemePlugin from "@fullcalendar/react/themes/classic";
import timeGridPlugin from "@fullcalendar/react/timegrid";
import "@fullcalendar/react/skeleton.css";
import "@fullcalendar/react/themes/classic/theme.css";
import "@fullcalendar/react/themes/classic/palette.css";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorState, LoadingState, PageHeader } from "@/components/states";
import { APPT_CALENDAR_COLOUR } from "@/components/status-badge";
import { affiliatedClinics } from "@/features/clinician/home-clinic";
import { useApi } from "@/lib/data/context";
import { APPOINTMENT_STATUS_LABEL, personName } from "@/lib/format";
import { useLiveQuery } from "@/lib/hooks/use-live-query";
import { useMe } from "@/lib/hooks/use-me";
import { todayUtc, userTimeZone, zoneDiffers } from "@/lib/time";
import type { AppointmentStatus } from "@/types/db";

const LEGEND: AppointmentStatus[] = ["booked", "confirmed", "checked_in", "in_consultation", "completed", "no_show", "cancelled"];

export default function ClinicianCalendarPage() {
  const api = useApi();
  const router = useRouter();
  const me = useMe();
  const clinicianId = me.data?.clinician?.id ?? "";
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);

  const clinics = useQuery({
    queryKey: ["clinician-clinics", clinicianId],
    queryFn: async () => {
      const [affiliations, facilities] = await Promise.all([api.listAffiliations(clinicianId), api.listFacilities()]);
      return affiliatedClinics(affiliations, facilities, todayUtc());
    },
    enabled: !!clinicianId,
  });
  const timeZone = clinics.data?.[0]?.timezone ?? userTimeZone();

  const appointments = useLiveQuery(
    ["appointments", "calendar", clinicianId, range?.from, range?.to],
    () => api.listAppointments({ clinicianId, from: range!.from, to: range!.to }),
    { enabled: !!clinicianId && !!range, intervalMs: 30_000, placeholderData: (prev) => prev },
  );

  const events = (appointments.data ?? [])
    .filter((a) => a.status !== "rescheduled")
    .map((a) => ({
      id: a.id,
      title: `${a.patient ? personName(a.patient) : "Patient"} · ${APPOINTMENT_STATUS_LABEL[a.status]}`,
      start: a.scheduled_start,
      end: a.scheduled_end,
      url: `/clinician/appointments/${a.id}`,
      color: APPT_CALENDAR_COLOUR[a.status],
      textColor: "#ffffff",
    }));

  return (
    <>
      <PageHeader
        title="My calendar"
        description={
          clinics.data?.length
            ? `Times in ${clinics.data[0].name}'s time zone${zoneDiffers(new Date(), timeZone) ? ` (${timeZone})` : ""}.`
            : undefined
        }
      />
      <ul className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Status colours">
        {LEGEND.map((s) => (
          <li key={s} className="flex items-center gap-1.5">
            <span className="inline-block size-3 rounded-sm" style={{ background: APPT_CALENDAR_COLOUR[s] }} aria-hidden="true" />
            {APPOINTMENT_STATUS_LABEL[s]}
          </li>
        ))}
      </ul>
      {appointments.isError ? <ErrorState error={appointments.error} onRetry={() => void appointments.refetch()} /> : null}
      {!clinicianId || clinics.isPending ? (
        <LoadingState />
      ) : (
        <div className="rounded-lg border bg-card p-2">
          <FullCalendar
            plugins={[dayGridPlugin, timeGridPlugin, classicThemePlugin]}
            locale={enAuLocale}
            timeZone={timeZone}
            initialView="timeGridDay"
            headerToolbar={{ start: "prev,next today", center: "title", end: "timeGridDay,timeGridWeek,dayGridMonth" }}
            nowIndicator
            slotMinTime="07:00:00"
            slotMaxTime="20:00:00"
            height="auto"
            events={events}
            datesSet={(info) => {
              const next = { from: info.start.toISOString(), to: info.end.toISOString() };
              setRange((prev) => (prev?.from === next.from && prev?.to === next.to ? prev : next));
            }}
            eventClick={(info) => {
              info.jsEvent.preventDefault();
              router.push(`/clinician/appointments/${info.event.id}`);
            }}
          />
        </div>
      )}
      {appointments.isFetching && appointments.data ? (
        <p className="sr-only" role="status">
          Updating
        </p>
      ) : null}
    </>
  );
}
