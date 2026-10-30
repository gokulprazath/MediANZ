"use client";
// One clinician: profile, qualifications, registration history and clinic
// affiliations. History rows are ended, never overwritten.
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { Field } from "@/components/form-field";
import { NativeSelect } from "@/components/native-select";
import { EmptyState, PageHeader, QueryView } from "@/components/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionCard } from "@/features/profile/sections";
import { ClinicianProfileForm, LOGIN_LINK_NOTE } from "@/features/staff/clinician-forms";
import { useApi } from "@/lib/data/context";
import { friendlyError } from "@/lib/errors";
import { clinicianName, REGISTRATION_STATUS_LABEL } from "@/lib/format";
import { validOn } from "@/lib/history";
import { addDays, formatIsoDate, todayUtc } from "@/lib/time";
import { affiliationSchema, qualificationSchema, registrationSchema } from "@/lib/validation";
import { REGISTRATION_STATUSES, type ClinicianQualification } from "@/types/db";

function QualificationForm({
  clinicianId,
  existing,
  onDone,
}: {
  clinicianId: string;
  existing?: ClinicianQualification;
  onDone: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const form = useForm({
    resolver: zodResolver(qualificationSchema),
    defaultValues: {
      qualification: existing?.qualification ?? "",
      institution: existing?.institution ?? "",
      year_awarded: (existing?.year_awarded ?? "") as string | number,
    },
  });
  const { errors, isSubmitting } = form.formState;
  return (
    <form
      noValidate
      className="grid gap-3 sm:grid-cols-4"
      onSubmit={form.handleSubmit(async (v) => {
        try {
          if (existing) await api.updateQualification(existing.id, v);
          else await api.addQualification(clinicianId, v);
          await qc.invalidateQueries({ queryKey: ["clinician-admin", clinicianId] });
          toast.success("Qualification saved");
          onDone();
        } catch (err) {
          toast.error(friendlyError(err));
        }
      })}
    >
      <Field label="Qualification" error={errors.qualification?.message} required>
        <Input {...form.register("qualification")} />
      </Field>
      <Field label="Institution" error={errors.institution?.message} className="sm:col-span-2">
        <Input {...form.register("institution")} />
      </Field>
      <Field label="Year" error={errors.year_awarded?.message}>
        <Input type="number" min={1900} max={2100} {...form.register("year_awarded")} />
      </Field>
      <div className="flex gap-2 sm:col-span-4">
        <Button type="submit" size="sm" disabled={isSubmitting}>
          Save
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export default function ClinicianAdminPage() {
  const api = useApi();
  const qc = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const today = todayUtc();
  const [editingQual, setEditingQual] = useState<string | "new" | null>(null);

  const query = useQuery({
    queryKey: ["clinician-admin", id],
    queryFn: async () => {
      const [clinicians, quals, regs, affs, facilities] = await Promise.all([
        api.listClinicians(),
        api.listQualifications(id),
        api.listRegistrations(id),
        api.listAffiliations(id),
        api.listFacilities(),
      ]);
      return { clinician: clinicians.find((c) => c.id === id) ?? null, quals, regs, affs, facilities };
    },
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["clinician-admin", id] });

  const regForm = useForm({
    resolver: zodResolver(registrationSchema),
    defaultValues: { status: "registered" as (typeof REGISTRATION_STATUSES)[number], conditions: "", valid_from: today },
  });
  const affForm = useForm({
    resolver: zodResolver(affiliationSchema),
    defaultValues: { facility_id: "", role: "", medicare_provider_number: "", valid_from: today, valid_to: "" },
  });

  return (
    <QueryView query={query}>
      {({ clinician, quals, regs, affs, facilities }) =>
        !clinician ? (
          <EmptyState title="Clinician not found" />
        ) : (
          <div className="grid gap-6">
            <PageHeader title={clinicianName(clinician)} description={clinician.auth_user_id ? "Login linked" : "No login linked yet"} />
            {!clinician.auth_user_id ? (
              <Alert>
                <AlertDescription>{LOGIN_LINK_NOTE}</AlertDescription>
              </Alert>
            ) : null}

            <SectionCard id="profile" title="Profile">
              <ClinicianProfileForm
                clinician={clinician}
                submitLabel="Save profile"
                onSubmit={async (v) => {
                  try {
                    await api.updateClinician(clinician.id, v);
                    await refresh();
                    toast.success("Profile saved");
                  } catch (err) {
                    toast.error(friendlyError(err));
                  }
                }}
              />
            </SectionCard>

            <SectionCard id="qualifications" title="Qualifications">
              <ul className="grid gap-2">
                {quals.map((q) => (
                  <li key={q.id} className="rounded-md border p-3">
                    {editingQual === q.id ? (
                      <QualificationForm clinicianId={id} existing={q} onDone={() => setEditingQual(null)} />
                    ) : (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          <strong>{q.qualification}</strong>
                          {q.institution ? `, ${q.institution}` : ""}
                          {q.year_awarded ? ` (${q.year_awarded})` : ""}
                        </span>
                        <Button size="sm" variant="outline" onClick={() => setEditingQual(q.id)}>
                          Edit
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              <div className="mt-3">
                {editingQual === "new" ? (
                  <QualificationForm clinicianId={id} onDone={() => setEditingQual(null)} />
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setEditingQual("new")}>
                    Add qualification
                  </Button>
                )}
              </div>
            </SectionCard>

            <SectionCard id="registration" title="AHPRA registration history" description="Adding a new status ends the current one on its start date.">
              <ul className="grid gap-1">
                {regs.map((r) => (
                  <li key={r.id} className="rounded-md border px-3 py-2">
                    <strong>{REGISTRATION_STATUS_LABEL[r.status]}</strong>
                    {r.conditions ? ` — ${r.conditions}` : ""}
                    <span className="text-sm text-muted-foreground">
                      {" "}
                      · {formatIsoDate(r.valid_from)} to {r.valid_to ? formatIsoDate(r.valid_to) : "now"}
                    </span>
                  </li>
                ))}
              </ul>
              <form
                noValidate
                className="mt-4 grid gap-3 sm:grid-cols-4"
                onSubmit={regForm.handleSubmit(async (v) => {
                  try {
                    await api.addRegistration(id, v);
                    await refresh();
                    toast.success("Registration status added");
                  } catch (err) {
                    toast.error(friendlyError(err));
                  }
                })}
              >
                <Field label="New status" error={regForm.formState.errors.status?.message}>
                  <NativeSelect {...regForm.register("status")}>
                    {REGISTRATION_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {REGISTRATION_STATUS_LABEL[s]}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label="Conditions" error={regForm.formState.errors.conditions?.message} className="sm:col-span-2">
                  <Input {...regForm.register("conditions")} />
                </Field>
                <Field label="From" error={regForm.formState.errors.valid_from?.message}>
                  <Input type="date" {...regForm.register("valid_from")} />
                </Field>
                <div className="sm:col-span-4">
                  <Button type="submit" size="sm" disabled={regForm.formState.isSubmitting}>
                    Add status
                  </Button>
                </div>
              </form>
            </SectionCard>

            <SectionCard id="affiliations" title="Clinic affiliations" description="Where they work and when. End an affiliation instead of deleting it.">
              <ul className="grid gap-2">
                {affs
                  .sort((a, b) => b.valid_from.localeCompare(a.valid_from))
                  .map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
                      <span>
                        <strong>{facilities.find((f) => f.id === a.facility_id)?.name}</strong>
                        {a.role ? ` · ${a.role}` : ""}
                        {a.medicare_provider_number ? ` · Provider ${a.medicare_provider_number}` : ""}
                        <span className="text-sm text-muted-foreground">
                          {" "}
                          · {formatIsoDate(a.valid_from)} to {a.valid_to ? formatIsoDate(a.valid_to) : "now"}
                          {validOn(a, today) ? " (current)" : ""}
                        </span>
                      </span>
                      {a.valid_to === null ? (
                        <ConfirmAction
                          trigger="End"
                          size="sm"
                          variant="outline"
                          title="End this affiliation?"
                          description={`It ends ${formatIsoDate(a.valid_from >= today ? addDays(a.valid_from, 1) : today)}. Slots after that are no longer created for this clinic.`}
                          confirmLabel="End affiliation"
                          onConfirm={async () => {
                            try {
                              await api.endAffiliation(a.id, a.valid_from >= today ? addDays(a.valid_from, 1) : today);
                              await refresh();
                              toast.success("Affiliation ended");
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
              <form
                noValidate
                className="mt-4 grid gap-3 sm:grid-cols-3"
                onSubmit={affForm.handleSubmit(async (v) => {
                  try {
                    await api.addAffiliation({ ...v, clinician_id: id });
                    await refresh();
                    toast.success("Affiliation added");
                    affForm.reset();
                  } catch (err) {
                    toast.error(friendlyError(err));
                  }
                })}
              >
                <Field label="Clinic" error={affForm.formState.errors.facility_id?.message} required>
                  <NativeSelect {...affForm.register("facility_id")}>
                    <option value="">Choose…</option>
                    {facilities.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label="Role" error={affForm.formState.errors.role?.message} hint="e.g. GP, Registrar, VMO">
                  <Input {...affForm.register("role")} />
                </Field>
                <Field label="Medicare provider number" error={affForm.formState.errors.medicare_provider_number?.message}>
                  <Input autoComplete="off" {...affForm.register("medicare_provider_number")} />
                </Field>
                <Field label="Start" error={affForm.formState.errors.valid_from?.message} required>
                  <Input type="date" {...affForm.register("valid_from")} />
                </Field>
                <Field label="End (optional)" error={affForm.formState.errors.valid_to?.message}>
                  <Input type="date" {...affForm.register("valid_to")} />
                </Field>
                <div className="sm:col-span-3">
                  <Button type="submit" size="sm" disabled={affForm.formState.isSubmitting}>
                    Add affiliation
                  </Button>
                </div>
              </form>
            </SectionCard>
          </div>
        )
      }
    </QueryView>
  );
}
