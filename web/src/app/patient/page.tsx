"use client";
import { useQuery } from "@tanstack/react-query";
import { BellRing, CalendarClock, MapPin, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { EmergencyBanner } from "@/components/emergency-banner";
import { Field } from "@/components/form-field";
import { QueryView } from "@/components/states";
import { AppointmentStatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { containsEmergencyWords } from "@/config/emergency";
import { appointmentBanner, nextAppointment } from "@/features/appointments/banner";
import { useFindCare } from "@/features/find-care/context";
import { LocationPicker, RadiusInput } from "@/features/find-care/location-picker";
import { useApi } from "@/lib/data/context";
import { clinicianName } from "@/lib/format";
import { useLiveQuery } from "@/lib/hooks/use-live-query";
import { useMe } from "@/lib/hooks/use-me";
import { formatDateTime, localDate } from "@/lib/time";

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function UpcomingCard({ patientId }: { patientId: string }) {
  const api = useApi();
  const now = useNow();
  const query = useLiveQuery(["appointments", "upcoming", patientId], () =>
    api.listAppointments({ patientId, from: new Date(Date.now() - 3 * 3_600_000).toISOString() }),
  );
  return (
    <QueryView query={query}>
      {(rows) => {
        const next = nextAppointment(rows, now);
        const banner = appointmentBanner(next, now);
        return (
          <div className="grid gap-4">
            {banner ? (
              <Alert className="border-primary bg-accent">
                <BellRing aria-hidden="true" />
                <AlertTitle>{banner}</AlertTitle>
                <AlertDescription>
                  <Link href={`/patient/appointments/${next!.id}/live`} className="font-medium text-primary underline underline-offset-2">
                    Open appointment day
                  </Link>
                </AlertDescription>
              </Alert>
            ) : null}
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2 className="flex items-center gap-2 text-lg">
                    <CalendarClock className="size-5 text-primary" aria-hidden="true" />
                    Your next appointment
                  </h2>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {next ? (
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="grid gap-1">
                      <p className="text-lg font-medium">{formatDateTime(next.scheduled_start, next.facility.timezone)}</p>
                      <p>
                        {clinicianName(next.clinician)} · {next.facility.name}
                      </p>
                      <p className="flex items-center gap-1 text-sm text-muted-foreground">
                        <MapPin className="size-4" aria-hidden="true" />
                        {next.facility.address_line1}, {next.facility.suburb}
                      </p>
                      <AppointmentStatusBadge status={next.status} className="justify-self-start" />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {localDate(next.scheduled_start, next.facility.timezone) === localDate(now, next.facility.timezone) ? (
                        <Button asChild>
                          <Link href={`/patient/appointments/${next.id}/live`}>Appointment day</Link>
                        </Button>
                      ) : null}
                      <Button asChild variant="outline">
                        <Link href="/patient/appointments">Manage</Link>
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-muted-foreground">You have no upcoming appointments.</p>
                )}
              </CardContent>
            </Card>
          </div>
        );
      }}
    </QueryView>
  );
}

function PendingTranscripts() {
  const api = useApi();
  const query = useQuery({ queryKey: ["transcripts", "mine"], queryFn: () => api.listTranscripts() });
  const pending = query.data?.filter((t) => t.status === "pending_patient_review") ?? [];
  if (!pending.length) return null;
  return (
    <Alert>
      <AlertTitle>A consultation transcript is waiting for your review</AlertTitle>
      <AlertDescription>
        <Link href={`/patient/transcripts/${pending[0].id}`} className="font-medium text-primary underline underline-offset-2">
          Review it now
        </Link>{" "}
        — drafts you don&apos;t review are deleted when the review period ends.
      </AlertDescription>
    </Alert>
  );
}

function FindCare() {
  const router = useRouter();
  const { reason, setReason } = useFindCare();
  const emergency = containsEmergencyWords(reason);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-lg">Find care</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {emergency ? <EmergencyBanner /> : null}
        <Field
          label="What do you need help with?"
          hint="This goes on your booking as the reason for the visit, so the clinic can prepare. It isn't used to give medical advice."
        >
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} />
        </Field>
        <div className="flex flex-wrap items-start gap-6">
          <RadiusInput />
          <LocationPicker />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => router.push("/patient/concierge")}>
            <Sparkles aria-hidden="true" />
            Find care with AI
          </Button>
          <Button variant="outline" onClick={() => router.push("/patient/find")}>
            Show clinics on a map
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function PatientHome() {
  const me = useMe();
  const patient = me.data?.patient;
  if (!patient) return null;
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">Hi {patient.preferred_name ?? patient.first_name}</h1>
      <UpcomingCard patientId={patient.id} />
      <PendingTranscripts />
      <FindCare />
    </div>
  );
}
