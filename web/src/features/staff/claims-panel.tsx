"use client";
// Insurance claims for one visit (insurance_claims). The policy is filled in by
// the database trigger from the visit date; if the patient had no policy that
// day the insert fails and we say so.
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Field } from "@/components/form-field";
import { NativeSelect } from "@/components/native-select";
import { EmptyState, QueryView } from "@/components/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useApi } from "@/lib/data/context";
import { friendlyError } from "@/lib/errors";
import { CLAIM_STATUS_LABEL, formatMoney } from "@/lib/format";
import { formatDateTime } from "@/lib/time";
import { claimSchema } from "@/lib/validation";
import { CLAIM_STATUSES, type ClaimStatus, type InsuranceClaim } from "@/types/db";

const asText = (n: number | null) => (n === null ? "" : n.toFixed(2));

function ClaimForm({
  appointmentId,
  claim,
  defaultAmount,
  onDone,
}: {
  appointmentId: string;
  claim?: InsuranceClaim;
  defaultAmount: number | null;
  onDone: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const form = useForm({
    resolver: zodResolver(claimSchema),
    defaultValues: {
      claim_number: claim?.claim_number ?? "",
      amount_claimed: (claim ? asText(claim.amount_claimed) : asText(defaultAmount)) as string | number,
      amount_approved: asText(claim?.amount_approved ?? null) as string | number,
      amount_paid: asText(claim?.amount_paid ?? null) as string | number,
      status: (claim?.status ?? "draft") as ClaimStatus,
      rejection_reason: claim?.rejection_reason ?? "",
    },
  });
  const { errors, isSubmitting } = form.formState;
  const status = form.watch("status");

  return (
    <form
      noValidate
      className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2"
      aria-label={claim ? "Edit claim" : "New claim"}
      onSubmit={form.handleSubmit(async (v) => {
        setError(null);
        try {
          if (claim) {
            await api.updateClaim(claim.id, {
              ...v,
              rejection_reason: v.status === "rejected" ? v.rejection_reason : null,
            });
            toast.success("Claim updated");
          } else {
            await api.createClaim({
              appointment_id: appointmentId,
              amount_claimed: v.amount_claimed,
              claim_number: v.claim_number,
              status: v.status,
            });
            toast.success("Claim created");
          }
          await qc.invalidateQueries({ queryKey: ["claims", appointmentId] });
          onDone();
        } catch (err) {
          const msg = friendlyError(err);
          setError(msg);
          toast.error(msg);
        }
      })}
    >
      {error ? (
        <Alert variant="destructive" className="sm:col-span-2">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Field label="Claim number" error={errors.claim_number?.message} hint="From the insurer, if you have one.">
        <Input {...form.register("claim_number")} />
      </Field>
      <Field label="Status" error={errors.status?.message}>
        <NativeSelect {...form.register("status")}>
          {CLAIM_STATUSES.map((s) => (
            <option key={s} value={s}>
              {CLAIM_STATUS_LABEL[s]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Amount claimed ($)" error={errors.amount_claimed?.message} required>
        <Input type="number" inputMode="decimal" min={0} step="0.01" {...form.register("amount_claimed")} />
      </Field>
      {claim ? (
        <>
          <Field label="Amount approved ($)" error={errors.amount_approved?.message}>
            <Input type="number" inputMode="decimal" min={0} step="0.01" {...form.register("amount_approved")} />
          </Field>
          <Field label="Amount paid ($)" error={errors.amount_paid?.message}>
            <Input type="number" inputMode="decimal" min={0} step="0.01" {...form.register("amount_paid")} />
          </Field>
          {status === "rejected" ? (
            <Field label="Rejection reason" error={errors.rejection_reason?.message} className="sm:col-span-2">
              <Textarea rows={2} maxLength={500} {...form.register("rejection_reason")} />
            </Field>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted-foreground sm:col-span-2">
          The patient&apos;s insurance policy on the visit date is attached automatically.
        </p>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : claim ? "Save claim" : "Create claim"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function ClaimsPanel({
  appointmentId,
  timeZone,
  defaultAmount,
}: {
  appointmentId: string;
  timeZone: string;
  defaultAmount: number | null;
}) {
  const api = useApi();
  const query = useQuery({ queryKey: ["claims", appointmentId], queryFn: () => api.listClaims([appointmentId]) });
  const [editing, setEditing] = useState<string | "new" | null>(null);

  return (
    <div className="grid gap-4">
      <QueryView query={query}>
        {(claims) =>
          claims.length === 0 && editing !== "new" ? (
            <EmptyState title="No claims for this visit" />
          ) : (
            <ul className="grid gap-3">
              {claims.map((c) =>
                editing === c.id ? (
                  <li key={c.id}>
                    <ClaimForm appointmentId={appointmentId} claim={c} defaultAmount={defaultAmount} onDone={() => setEditing(null)} />
                  </li>
                ) : (
                  <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-4">
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                      <dt className="text-muted-foreground">Claim</dt>
                      <dd className="font-medium">{c.claim_number ?? "No number yet"}</dd>
                      <dt className="text-muted-foreground">Status</dt>
                      <dd>{CLAIM_STATUS_LABEL[c.status]}</dd>
                      <dt className="text-muted-foreground">Claimed</dt>
                      <dd className="tabular-nums">{formatMoney(c.amount_claimed)}</dd>
                      <dt className="text-muted-foreground">Approved</dt>
                      <dd className="tabular-nums">{formatMoney(c.amount_approved)}</dd>
                      <dt className="text-muted-foreground">Paid</dt>
                      <dd className="tabular-nums">{formatMoney(c.amount_paid)}</dd>
                      {c.submitted_at ? (
                        <>
                          <dt className="text-muted-foreground">Submitted</dt>
                          <dd>{formatDateTime(c.submitted_at, timeZone)}</dd>
                        </>
                      ) : null}
                      {c.processed_at ? (
                        <>
                          <dt className="text-muted-foreground">Processed</dt>
                          <dd>{formatDateTime(c.processed_at, timeZone)}</dd>
                        </>
                      ) : null}
                      {c.status === "rejected" && c.rejection_reason ? (
                        <>
                          <dt className="text-muted-foreground">Rejection reason</dt>
                          <dd>{c.rejection_reason}</dd>
                        </>
                      ) : null}
                    </dl>
                    <Button size="sm" variant="outline" onClick={() => setEditing(c.id)}>
                      Update
                    </Button>
                  </li>
                ),
              )}
            </ul>
          )
        }
      </QueryView>
      {editing === "new" ? (
        <ClaimForm appointmentId={appointmentId} defaultAmount={defaultAmount} onDone={() => setEditing(null)} />
      ) : (
        <div>
          <Button variant="outline" onClick={() => setEditing("new")}>
            New claim
          </Button>
        </div>
      )}
    </div>
  );
}
