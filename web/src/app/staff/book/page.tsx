"use client";
// Book on behalf of a patient: book_slot(..., p_channel => 'reception' | 'phone', p_patient_id => ...).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { toast } from "sonner";
import { Field } from "@/components/form-field";
import { NativeSelect } from "@/components/native-select";
import { EmptyState, LoadingState, PageHeader, QueryView } from "@/components/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RequireClinic } from "@/features/staff/clinic-context";
import { PatientSearch } from "@/features/staff/patient-search";
import { clinicToday } from "@/lib/clinic-day";
import { useApi } from "@/lib/data/context";
import { friendlyError } from "@/lib/errors";
import { clinicianName, personName, VISIT_TYPES } from "@/lib/format";
import { validOn } from "@/lib/history";
import { formatDateTime, formatIsoDate, formatTime } from "@/lib/time";
import type { AvailableSlot, Facility, Patient } from "@/types/db";

function StaffBooking({ clinic, initialPatientId }: { clinic: Facility; initialPatientId: string | null }) {
  const api = useApi();
  const qc = useQueryClient();
  const tz = clinic.timezone;
  // undefined = not chosen here yet, so use ?patient= from the URL
  const [picked, setPicked] = useState<Patient | null | undefined>(undefined);
  const [date, setDate] = useState(clinicToday(tz));
  const [clinicianId, setClinicianId] = useState("");
  const [slot, setSlot] = useState<AvailableSlot | null>(null);
  const [channel, setChannel] = useState<"reception" | "phone">("reception");
  const [reason, setReason] = useState("");
  const [visitType, setVisitType] = useState("standard");
  const [busy, setBusy] = useState(false);
  const [booked, setBooked] = useState<{ id: string; label: string } | null>(null);

  const initial = useQuery({
    queryKey: ["patient", initialPatientId],
    queryFn: () => api.getPatient(initialPatientId!),
    enabled: !!initialPatientId,
  });
  const patient = picked === undefined ? (initial.data ?? null) : picked;
  const setPatient = (p: Patient | null) => setPicked(p);

  const clinicians = useQuery({
    queryKey: ["clinic-clinicians", clinic.id],
    queryFn: async () => {
      const [affs, all] = await Promise.all([api.listAffiliations(), api.listClinicians()]);
      const today = clinicToday(tz);
      const ids = new Set(affs.filter((a) => a.facility_id === clinic.id && validOn(a, today)).map((a) => a.clinician_id));
      return all.filter((c) => ids.has(c.id) && c.is_active);
    },
  });

  const slots = useQuery({
    queryKey: ["slots", clinicianId || "any", clinic.id, date],
    queryFn: () => api.getAvailableSlots({ date, facilityId: clinic.id, clinicianId: clinicianId || null }),
    refetchInterval: 15_000,
  });

  const book = async () => {
    if (!patient || !slot) return;
    setBusy(true);
    try {
      const id = await api.bookSlot({
        slotId: slot.slot_id,
        patientId: patient.id,
        channel,
        reason: reason.trim() || null,
        visitType,
      });
      await qc.invalidateQueries({ queryKey: ["appointments"] });
      await qc.invalidateQueries({ queryKey: ["slots"] });
      toast.success("Appointment booked");
      setBooked({ id, label: `${personName(patient)} with ${slot.clinician_name}, ${formatDateTime(slot.starts_at, tz)}` });
      setSlot(null);
      setReason("");
    } catch (err) {
      toast.error(friendlyError(err));
      void qc.invalidateQueries({ queryKey: ["slots"] });
      setSlot(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Book for a patient" description={clinic.name} />
      {booked ? (
        <Alert className="mb-4" role="status">
          <AlertTitle>Booked: {booked.label}</AlertTitle>
          <AlertDescription>
            <Link href={`/staff/visits/${booked.id}`} className="text-primary underline underline-offset-2">
              View appointment
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[1fr_2fr]">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="text-lg">1. Patient</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {patient ? (
              <div className="flex items-start justify-between gap-2 rounded-md border p-3">
                <div>
                  <p className="font-medium">{personName(patient)}</p>
                  <p className="text-sm text-muted-foreground">Born {formatIsoDate(patient.date_of_birth)}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setPatient(null)}>
                  Change
                </Button>
              </div>
            ) : (
              <PatientSearch onSelect={setPatient} />
            )}
            <Button asChild variant="link" className="justify-self-start px-0">
              <Link href="/staff/patients/new">Register a new patient</Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <h2 className="text-lg">2. Time</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="flex flex-wrap gap-4">
              <Field label="Clinician" className="w-64">
                <NativeSelect value={clinicianId} onChange={(e) => (setClinicianId(e.target.value), setSlot(null))}>
                  <option value="">Any clinician</option>
                  {clinicians.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {clinicianName(c)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Day" className="w-44">
                <Input type="date" value={date} min={clinicToday(tz)} onChange={(e) => e.target.value && (setDate(e.target.value), setSlot(null))} />
              </Field>
            </div>
            <QueryView query={slots} loadingLabel="Loading times…">
              {(rows) =>
                rows.length === 0 ? (
                  <EmptyState title="No times available" />
                ) : (
                  <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {rows.map((s) => (
                      <li key={s.slot_id}>
                        <Button
                          variant={slot?.slot_id === s.slot_id ? "default" : "outline"}
                          aria-pressed={slot?.slot_id === s.slot_id}
                          className="h-auto w-full flex-col py-2"
                          onClick={() => setSlot(s)}
                        >
                          <span className="tabular-nums">{formatTime(s.starts_at, tz, { label: false })}</span>
                          {!clinicianId ? <span className="text-xs font-normal">{s.clinician_name}</span> : null}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )
              }
            </QueryView>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>
            <h2 className="text-lg">3. Confirm</h2>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Booked by">
            <NativeSelect value={channel} onChange={(e) => setChannel(e.target.value as "reception" | "phone")}>
              <option value="reception">At reception</option>
              <option value="phone">Over the phone</option>
            </NativeSelect>
          </Field>
          <Field label="Visit type">
            <NativeSelect value={visitType} onChange={(e) => setVisitType(e.target.value)}>
              {VISIT_TYPES.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Reason for the visit" className="sm:col-span-2" hint="As the patient describes it. Optional.">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} />
          </Field>
          <div className="sm:col-span-2">
            {busy ? <LoadingState label="Booking…" /> : null}
            <Button onClick={book} disabled={!patient || !slot || busy}>
              {patient && slot
                ? `Book ${personName(patient)} at ${formatTime(slot.starts_at, tz)}`
                : "Choose a patient and a time"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

function Inner() {
  const initialPatientId = useSearchParams().get("patient");
  return <RequireClinic>{(clinic) => <StaffBooking clinic={clinic} initialPatientId={initialPatientId} />}</RequireClinic>;
}

export default function StaffBookPage() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
