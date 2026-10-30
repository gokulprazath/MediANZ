"use client";
// Profile sections (4.1). Each one saves on its own. History-aware sections
// (address, residency, insurance) end the current row today and add a new row
// from today; past rows are shown read-only and never deleted.
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Field } from "@/components/form-field";
import { NativeSelect } from "@/components/native-select";
import { ConfirmAction } from "@/components/confirm-action";
import { QueryView } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useApi } from "@/lib/data/context";
import { friendlyError } from "@/lib/errors";
import { clinicianName, RECORDING_STATUS_LABEL, RESIDENCY_CATEGORY_LABEL } from "@/lib/format";
import { currentRow } from "@/lib/history";
import { formatDate, formatDateTime, formatIsoDate, todayUtc } from "@/lib/time";
import {
  addressSchema,
  bloodTypeSchema,
  emergencySchema,
  insuranceSchema,
  medicareSchema,
  residencySchema,
} from "@/lib/validation";
import { BLOOD_TYPES, type AddressType, type Patient, type PatientUpdate } from "@/types/db";

export const AU_STATES = ["QLD", "NSW", "VIC", "TAS", "SA", "WA", "NT", "ACT"];

export function SectionCard({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card id={id} aria-labelledby={`${id}-title`} role="region">
      <CardHeader>
        <CardTitle>
          <h2 id={`${id}-title`} className="text-lg">
            {title}
          </h2>
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function usePatientUpdate(patient: Patient, label: string) {
  const api = useApi();
  const qc = useQueryClient();
  return async (patch: PatientUpdate) => {
    try {
      await api.updatePatient(patient.id, patch);
      await qc.invalidateQueries({ queryKey: ["me"] });
      await qc.invalidateQueries({ queryKey: ["patient", patient.id] });
      toast.success(`${label} saved`);
    } catch (err) {
      toast.error(friendlyError(err));
      throw err;
    }
  };
}

export function MedicareSection({ patient }: { patient: Patient }) {
  const save = usePatientUpdate(patient, "Medicare details");
  const form = useForm({
    resolver: zodResolver(medicareSchema),
    defaultValues: {
      medicare_number: patient.medicare_number ?? "",
      medicare_irn: patient.medicare_irn ?? "",
      medicare_expiry: patient.medicare_expiry ?? "",
      ihi_number: patient.ihi_number ?? "",
    },
  });
  const { errors, isSubmitting, isDirty } = form.formState;
  return (
    <form
      noValidate
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={form.handleSubmit(async (v) => {
        await save(v).catch(() => undefined);
        form.reset(form.getValues());
      })}
    >
      <Field label="Medicare card number" error={errors.medicare_number?.message} hint="10 digits.">
        <Input inputMode="numeric" autoComplete="off" {...form.register("medicare_number")} />
      </Field>
      <Field label="IRN" error={errors.medicare_irn?.message} hint="The number (1–9) next to your name.">
        <Input type="number" min={1} max={9} inputMode="numeric" {...form.register("medicare_irn")} />
      </Field>
      <Field label="Card expiry" error={errors.medicare_expiry?.message}>
        <Input type="date" {...form.register("medicare_expiry")} />
      </Field>
      <Field label="IHI (optional)" error={errors.ihi_number?.message} hint="Individual Healthcare Identifier, 16 digits.">
        <Input inputMode="numeric" autoComplete="off" {...form.register("ihi_number")} />
      </Field>
      <div className="sm:col-span-2">
        <Button type="submit" disabled={isSubmitting || !isDirty}>
          Save Medicare details
        </Button>
      </div>
    </form>
  );
}

export function EmergencySection({ patient }: { patient: Patient }) {
  const save = usePatientUpdate(patient, "Emergency contact");
  const form = useForm({
    resolver: zodResolver(emergencySchema),
    defaultValues: {
      emergency_contact_name: patient.emergency_contact_name ?? "",
      emergency_contact_phone: patient.emergency_contact_phone ?? "",
      emergency_contact_relationship: patient.emergency_contact_relationship ?? "",
    },
  });
  const { errors, isSubmitting, isDirty } = form.formState;
  return (
    <form
      noValidate
      className="grid gap-4 sm:grid-cols-3"
      onSubmit={form.handleSubmit(async (v) => {
        await save(v).catch(() => undefined);
        form.reset(form.getValues());
      })}
    >
      <Field label="Name" error={errors.emergency_contact_name?.message}>
        <Input {...form.register("emergency_contact_name")} />
      </Field>
      <Field label="Phone" error={errors.emergency_contact_phone?.message}>
        <Input type="tel" {...form.register("emergency_contact_phone")} />
      </Field>
      <Field label="Relationship" error={errors.emergency_contact_relationship?.message} hint="For example: partner, parent.">
        <Input {...form.register("emergency_contact_relationship")} />
      </Field>
      <div className="sm:col-span-3">
        <Button type="submit" disabled={isSubmitting || !isDirty}>
          Save emergency contact
        </Button>
      </div>
    </form>
  );
}

export function BloodTypeSection({ patient }: { patient: Patient }) {
  const save = usePatientUpdate(patient, "Blood type");
  const form = useForm({ resolver: zodResolver(bloodTypeSchema), defaultValues: { blood_type: (patient.blood_type ?? "") as (typeof BLOOD_TYPES)[number] | "" } });
  return (
    <form
      noValidate
      className="flex flex-wrap items-end gap-3"
      onSubmit={form.handleSubmit(async (v) => {
        await save(v).catch(() => undefined);
        form.reset(form.getValues());
      })}
    >
      <Field label="Blood type" className="w-48">
        <NativeSelect {...form.register("blood_type")}>
          <option value="">Not provided</option>
          {BLOOD_TYPES.map((b) => (
            <option key={b} value={b}>
              {b === "unknown" ? "I don't know" : b}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Button type="submit" disabled={form.formState.isSubmitting || !form.formState.isDirty}>
        Save blood type
      </Button>
    </form>
  );
}

// --- address ------------------------------------------------------------------
function AddressForm({
  patientId,
  addressType,
  initial,
  onDone,
}: {
  patientId: string;
  addressType: AddressType;
  initial?: { address_line1: string; address_line2: string | null; suburb: string; state: string; postcode: string };
  onDone: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const form = useForm({
    resolver: zodResolver(addressSchema),
    defaultValues: {
      address_type: addressType,
      address_line1: initial?.address_line1 ?? "",
      address_line2: initial?.address_line2 ?? "",
      suburb: initial?.suburb ?? "",
      state: initial?.state ?? "QLD",
      postcode: initial?.postcode ?? "",
      country: "Australia",
    },
  });
  const { errors, isSubmitting } = form.formState;
  return (
    <form
      noValidate
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={form.handleSubmit(async (v) => {
        try {
          await api.changeAddress(patientId, { ...v, address_line2: v.address_line2 ?? null });
          await qc.invalidateQueries({ queryKey: ["addresses", patientId] });
          toast.success("Address saved. Your previous address is kept in your history.");
          onDone();
        } catch (err) {
          toast.error(friendlyError(err));
        }
      })}
    >
      <Field label="Street address" error={errors.address_line1?.message} required className="sm:col-span-2">
        <Input autoComplete="address-line1" {...form.register("address_line1")} />
      </Field>
      <Field label="Address line 2" error={errors.address_line2?.message} className="sm:col-span-2">
        <Input autoComplete="address-line2" {...form.register("address_line2")} />
      </Field>
      <Field label="Suburb" error={errors.suburb?.message} required>
        <Input autoComplete="address-level2" {...form.register("suburb")} />
      </Field>
      <div className="grid grid-cols-2 gap-4">
        <Field label="State" error={errors.state?.message} required>
          <NativeSelect autoComplete="address-level1" {...form.register("state")}>
            {AU_STATES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Postcode" error={errors.postcode?.message} required>
          <Input inputMode="numeric" autoComplete="postal-code" {...form.register("postcode")} />
        </Field>
      </div>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" disabled={isSubmitting}>
          Save address
        </Button>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const ADDRESS_LABEL: Record<AddressType, string> = { residential: "Home address", postal: "Postal address", billing: "Billing address" };

export function AddressSection({ patientId }: { patientId: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["addresses", patientId], queryFn: () => api.listAddresses(patientId) });
  const [editing, setEditing] = useState<AddressType | null>(null);
  const today = todayUtc();

  return (
    <QueryView query={query}>
      {(rows) => {
        const past = rows.filter((r) => r.valid_to !== null && r.valid_to <= today);
        return (
          <div className="grid gap-6">
            {(["residential", "postal"] as AddressType[]).map((type) => {
              const current = currentRow(rows, today, (r) => r.address_type === type);
              return (
                <div key={type} className="grid gap-2">
                  <h3 className="font-medium">{ADDRESS_LABEL[type]}</h3>
                  {editing === type ? (
                    <AddressForm patientId={patientId} addressType={type} initial={current} onDone={() => setEditing(null)} />
                  ) : current ? (
                    <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3">
                      <address className="not-italic">
                        {current.address_line1}
                        {current.address_line2 ? `, ${current.address_line2}` : ""}
                        <br />
                        {current.suburb} {current.state} {current.postcode}
                        <br />
                        <span className="text-sm text-muted-foreground">Since {formatIsoDate(current.valid_from)}</span>
                      </address>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => setEditing(type)}>
                          Change
                        </Button>
                        {type !== "residential" ? (
                          <ConfirmAction
                            trigger="Remove"
                            size="sm"
                            variant="ghost"
                            title={`Remove your ${ADDRESS_LABEL[type].toLowerCase()}?`}
                            description="It will end today and stay in your address history."
                            confirmLabel="Remove"
                            onConfirm={async () => {
                              try {
                                await api.endAddress(patientId, type);
                                await qc.invalidateQueries({ queryKey: ["addresses", patientId] });
                                toast.success("Address removed");
                              } catch (err) {
                                toast.error(friendlyError(err));
                                throw err;
                              }
                            }}
                          />
                        ) : null}
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <p className="text-sm text-muted-foreground">Not provided.</p>
                      <Button variant="outline" size="sm" onClick={() => setEditing(type)}>
                        Add {ADDRESS_LABEL[type].toLowerCase()}
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
            {past.length ? (
              <details className="rounded-md border p-3">
                <summary className="cursor-pointer font-medium">Past addresses ({past.length})</summary>
                <ul className="mt-2 grid gap-2 text-sm">
                  {past.map((a) => (
                    <li key={a.id}>
                      {ADDRESS_LABEL[a.address_type]}: {a.address_line1}, {a.suburb} {a.state} {a.postcode}{" "}
                      <span className="text-muted-foreground">
                        ({formatIsoDate(a.valid_from)} to {formatIsoDate(a.valid_to!)})
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        );
      }}
    </QueryView>
  );
}

// --- residency ------------------------------------------------------------------
export function ResidencySection({ patientId }: { patientId: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const rows = useQuery({ queryKey: ["residency", patientId], queryFn: () => api.listResidency(patientId) });
  const statuses = useQuery({ queryKey: ["residency-statuses"], queryFn: () => api.listResidencyStatuses(), staleTime: Infinity });
  const [editing, setEditing] = useState(false);
  const today = todayUtc();
  const current = rows.data ? currentRow(rows.data, today) : undefined;
  const form = useForm({
    resolver: zodResolver(residencySchema),
    values: { residency_status_id: current?.residency_status_id ?? "", visa_grant_number: current?.visa_grant_number ?? "" },
  });
  const nameOf = (id: string) => statuses.data?.find((s) => s.id === id);

  return (
    <QueryView query={rows}>
      {(list) => (
        <div className="grid gap-4">
          {editing ? (
            <form
              noValidate
              className="grid gap-4 sm:grid-cols-2"
              onSubmit={form.handleSubmit(async (v) => {
                try {
                  await api.changeResidency(patientId, v);
                  await qc.invalidateQueries({ queryKey: ["residency", patientId] });
                  toast.success("Residency saved");
                  setEditing(false);
                } catch (err) {
                  toast.error(friendlyError(err));
                }
              })}
            >
              <Field label="Residency or visa status" error={form.formState.errors.residency_status_id?.message} required>
                <NativeSelect {...form.register("residency_status_id")}>
                  <option value="">Choose…</option>
                  {statuses.data?.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.visa_subclass ? ` (subclass ${s.visa_subclass})` : ""}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Visa grant number" error={form.formState.errors.visa_grant_number?.message} hint="If you have a visa.">
                <Input autoComplete="off" {...form.register("visa_grant_number")} />
              </Field>
              <div className="flex gap-2 sm:col-span-2">
                <Button type="submit" disabled={form.formState.isSubmitting}>
                  Save residency
                </Button>
                <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3">
              {current ? (
                <div>
                  <p className="font-medium">{nameOf(current.residency_status_id)?.name ?? "—"}</p>
                  <p className="text-sm text-muted-foreground">
                    {RESIDENCY_CATEGORY_LABEL[nameOf(current.residency_status_id)?.category ?? "other"]}
                    {nameOf(current.residency_status_id)?.medicare_eligible ? " · Medicare eligible" : " · Not Medicare eligible"}
                    {" · "}since {formatIsoDate(current.valid_from)}
                    {current.valid_to ? ` until ${formatIsoDate(current.valid_to)}` : ""}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Not provided.</p>
              )}
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                {current ? "Change" : "Add"}
              </Button>
            </div>
          )}
          {list.filter((r) => r !== current).length ? (
            <details className="rounded-md border p-3">
              <summary className="cursor-pointer font-medium">Residency history</summary>
              <ul className="mt-2 grid gap-1 text-sm">
                {list
                  .filter((r) => r !== current)
                  .map((r) => (
                    <li key={r.id}>
                      {nameOf(r.residency_status_id)?.name ?? "—"}{" "}
                      <span className="text-muted-foreground">
                        ({formatIsoDate(r.valid_from)} to {r.valid_to ? formatIsoDate(r.valid_to) : "now"})
                      </span>
                    </li>
                  ))}
              </ul>
            </details>
          ) : null}
        </div>
      )}
    </QueryView>
  );
}

// --- insurance ------------------------------------------------------------------
export function InsuranceSection({ patientId }: { patientId: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const rows = useQuery({ queryKey: ["policies", patientId], queryFn: () => api.listPolicies(patientId) });
  const providers = useQuery({ queryKey: ["insurance-providers"], queryFn: () => api.listInsuranceProviders(), staleTime: Infinity });
  const plans = useQuery({ queryKey: ["insurance-plans"], queryFn: () => api.listInsurancePlans(), staleTime: Infinity });
  const [editing, setEditing] = useState(false);
  const today = todayUtc();
  const current = rows.data ? currentRow(rows.data, today) : undefined;
  const planOf = (id: string) => plans.data?.find((p) => p.id === id);
  const providerOf = (id: string | undefined) => providers.data?.find((p) => p.id === id);
  const form = useForm({
    resolver: zodResolver(insuranceSchema),
    values: {
      provider_id: current ? (planOf(current.plan_id)?.provider_id ?? "") : "",
      plan_id: current?.plan_id ?? "",
      membership_number: current?.membership_number ?? "",
      is_primary_holder: current?.is_primary_holder ?? true,
    },
  });
  const providerId = form.watch("provider_id");
  const none = useMutation({
    mutationFn: () => api.changePolicy(patientId, null),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["policies", patientId] });
      toast.success("Saved: no private insurance");
    },
    onError: (err) => toast.error(friendlyError(err)),
  });

  return (
    <QueryView query={rows}>
      {(list) => (
        <div className="grid gap-4">
          {editing ? (
            <form
              noValidate
              className="grid gap-4 sm:grid-cols-2"
              onSubmit={form.handleSubmit(async ({ plan_id, membership_number, is_primary_holder }) => {
                try {
                  await api.changePolicy(patientId, { plan_id, membership_number, is_primary_holder });
                  await qc.invalidateQueries({ queryKey: ["policies", patientId] });
                  toast.success("Insurance saved. Your previous policy is kept in your history.");
                  setEditing(false);
                } catch (err) {
                  toast.error(friendlyError(err));
                }
              })}
            >
              <Field label="Insurer" error={form.formState.errors.provider_id?.message} required>
                <NativeSelect
                  {...form.register("provider_id", { onChange: () => form.setValue("plan_id", "") })}
                >
                  <option value="">Choose…</option>
                  {providers.data
                    ?.filter((p) => p.is_active)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </NativeSelect>
              </Field>
              <Field label="Plan" error={form.formState.errors.plan_id?.message} required>
                <NativeSelect disabled={!providerId} {...form.register("plan_id")}>
                  <option value="">Choose…</option>
                  {plans.data
                    ?.filter((p) => p.provider_id === providerId && p.is_active)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.plan_name}
                      </option>
                    ))}
                </NativeSelect>
              </Field>
              <Field label="Membership number" error={form.formState.errors.membership_number?.message} required>
                <Input autoComplete="off" {...form.register("membership_number")} />
              </Field>
              <div className="flex items-center gap-2 pt-6">
                <Checkbox
                  id="primary-holder"
                  checked={form.watch("is_primary_holder")}
                  onCheckedChange={(v) => form.setValue("is_primary_holder", v === true, { shouldDirty: true })}
                />
                <Label htmlFor="primary-holder">I&apos;m the main policy holder</Label>
              </div>
              <div className="flex gap-2 sm:col-span-2">
                <Button type="submit" disabled={form.formState.isSubmitting}>
                  Save insurance
                </Button>
                <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border p-3">
              {current ? (
                <div>
                  <p className="font-medium">
                    {providerOf(planOf(current.plan_id)?.provider_id)?.name} · {planOf(current.plan_id)?.plan_name}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Membership {current.membership_number} · {current.is_primary_holder ? "Main holder" : "Dependant"} · since{" "}
                    {formatIsoDate(current.valid_from)}
                    {current.valid_to ? ` until ${formatIsoDate(current.valid_to)}` : ""}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No private insurance.</p>
              )}
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                  {current ? "Change" : "Add insurance"}
                </Button>
                {current ? (
                  <ConfirmAction
                    trigger="No private insurance"
                    size="sm"
                    variant="ghost"
                    title="Remove your private insurance?"
                    description="Your current policy will end today. It stays in your history and on past visits."
                    confirmLabel="Remove insurance"
                    onConfirm={() => none.mutateAsync()}
                  />
                ) : null}
              </div>
            </div>
          )}
          {list.filter((r) => r !== current).length ? (
            <details className="rounded-md border p-3">
              <summary className="cursor-pointer font-medium">Insurance history</summary>
              <ul className="mt-2 grid gap-1 text-sm">
                {list
                  .filter((r) => r !== current)
                  .map((r) => (
                    <li key={r.id}>
                      {providerOf(planOf(r.plan_id)?.provider_id)?.name} · {planOf(r.plan_id)?.plan_name}{" "}
                      <span className="text-muted-foreground">
                        ({formatIsoDate(r.valid_from)} to {r.valid_to ? formatIsoDate(r.valid_to) : "now"})
                      </span>
                    </li>
                  ))}
              </ul>
            </details>
          ) : null}
        </div>
      )}
    </QueryView>
  );
}

// --- recordings and transcripts -----------------------------------------------------
export function RecordingsSection({ patientId }: { patientId: string }) {
  const api = useApi();
  const query = useQuery({
    queryKey: ["recordings", patientId],
    queryFn: async () => {
      const [appointments, sessions, transcripts] = await Promise.all([
        api.listAppointments({ patientId, ascending: false }),
        api.listRecordingSessions(),
        api.listTranscripts(),
      ]);
      return { appointments, sessions, transcripts };
    },
  });
  return (
    <QueryView query={query}>
      {({ appointments, sessions, transcripts }) =>
        sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No consultations have been recorded.</p>
        ) : (
          <ul className="grid gap-2">
            {sessions.map((s) => {
              const a = appointments.find((x) => x.id === s.appointment_id);
              const t = transcripts.find((x) => x.recording_session_id === s.id);
              return (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
                  <div>
                    <p className="font-medium">
                      {a ? `${formatDate(a.scheduled_start, a.facility.timezone)} · ${clinicianName(a.clinician)}` : "Consultation"}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Recorded {a ? formatDateTime(s.started_at, a.facility.timezone) : ""} ·{" "}
                      {t?.status === "pending_patient_review" ? "Draft waiting for your review" : RECORDING_STATUS_LABEL[s.status]}
                    </p>
                  </div>
                  {t ? (
                    <Button asChild size="sm" variant={t.status === "pending_patient_review" ? "default" : "outline"}>
                      <Link href={`/patient/transcripts/${t.id}`}>
                        {t.status === "pending_patient_review" ? "Review draft" : "View transcript"}
                      </Link>
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )
      }
    </QueryView>
  );
}
