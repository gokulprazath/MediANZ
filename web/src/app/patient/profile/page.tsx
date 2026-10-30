"use client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { toast } from "sonner";
import { LoadingState, PageHeader } from "@/components/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { useApi } from "@/lib/data/context";
import { friendlyError } from "@/lib/errors";
import { useMe } from "@/lib/hooks/use-me";
import { profileCompleteness } from "@/features/profile/completeness";
import { PersonalForm } from "@/features/profile/personal-form";
import {
  AddressSection,
  BloodTypeSection,
  EmergencySection,
  InsuranceSection,
  MedicareSection,
  RecordingsSection,
  ResidencySection,
  SectionCard,
} from "@/features/profile/sections";

function Completeness({ patientId }: { patientId: string }) {
  const api = useApi();
  const me = useMe();
  const addresses = useQuery({ queryKey: ["addresses", patientId], queryFn: () => api.listAddresses(patientId) });
  const residency = useQuery({ queryKey: ["residency", patientId], queryFn: () => api.listResidency(patientId) });
  const statuses = useQuery({ queryKey: ["residency-statuses"], queryFn: () => api.listResidencyStatuses(), staleTime: Infinity });
  if (!me.data?.patient || !addresses.data || !residency.data || !statuses.data) return null;
  const c = profileCompleteness(me.data.patient, addresses.data, residency.data, statuses.data);
  return (
    <section aria-labelledby="completeness-title" className="mb-6 rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 id="completeness-title" className="font-medium">
          Profile {c.percent}% complete
        </h2>
        <span className="text-sm text-muted-foreground">
          {c.done} of {c.total} sections
        </span>
      </div>
      <Progress value={c.percent} className="mt-2" aria-label={`Profile ${c.percent}% complete`} />
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {c.items.map((i) => (
          <li key={i.key} className="flex items-center gap-1">
            {i.done ? (
              <CheckCircle2 className="size-4 text-success" aria-hidden="true" />
            ) : (
              <Circle className="size-4 text-muted-foreground" aria-hidden="true" />
            )}
            <a href={`#${i.key}`} className="underline-offset-2 hover:underline">
              {i.label}
            </a>
            <span className="sr-only">{i.done ? "(complete)" : "(to do)"}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ProfileInner() {
  const api = useApi();
  const qc = useQueryClient();
  const me = useMe();
  const welcome = useSearchParams().get("welcome");
  const patient = me.data?.patient;
  if (!patient) return <LoadingState />;

  return (
    <>
      <PageHeader title="My profile" description="Each section saves on its own. You can update it any time." />
      {welcome ? (
        <Alert className="mb-4" role="status">
          <AlertDescription>Your profile is created. Add the rest of your details below when you&apos;re ready.</AlertDescription>
        </Alert>
      ) : null}
      <Completeness patientId={patient.id} />
      <div className="grid gap-6">
        <SectionCard id="personal" title="Personal details">
          <PersonalForm
            patient={patient}
            onSubmit={async (values) => {
              try {
                await api.updatePatient(patient.id, values);
                await qc.invalidateQueries({ queryKey: ["me"] });
                toast.success("Personal details saved");
              } catch (err) {
                toast.error(friendlyError(err));
              }
            }}
          />
        </SectionCard>
        <SectionCard id="medicare" title="Medicare">
          <MedicareSection patient={patient} />
        </SectionCard>
        <SectionCard id="emergency" title="Emergency contact">
          <EmergencySection patient={patient} />
        </SectionCard>
        <SectionCard id="blood" title="Blood type">
          <BloodTypeSection patient={patient} />
        </SectionCard>
        <SectionCard id="address" title="Address" description="When you move, your old address is kept in your history.">
          <AddressSection patientId={patient.id} />
        </SectionCard>
        <SectionCard id="residency" title="Residency or visa" description="Used to work out Medicare eligibility.">
          <ResidencySection patientId={patient.id} />
        </SectionCard>
        <SectionCard id="insurance" title="Private health insurance" description="One policy at a time. Past policies stay on past visits.">
          <InsuranceSection patientId={patient.id} />
        </SectionCard>
        <SectionCard
          id="recordings"
          title="My recordings and transcripts"
          description="Audio is never stored. Only transcripts you approve are kept."
        >
          <RecordingsSection patientId={patient.id} />
        </SectionCard>
      </div>
    </>
  );
}

export default function ProfilePage() {
  return (
    <Suspense>
      <ProfileInner />
    </Suspense>
  );
}
