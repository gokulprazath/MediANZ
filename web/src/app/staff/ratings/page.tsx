"use client";
// Rating moderation (6.5): ratings with comments for this clinic's visits.
// Staff hide or flag a rating only for abusive or clinical content.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Field } from "@/components/form-field";
import { NativeSelect } from "@/components/native-select";
import { StarDisplay } from "@/components/star-rating";
import { EmptyState, PageHeader, QueryView } from "@/components/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { RequireClinic } from "@/features/staff/clinic-context";
import { useApi } from "@/lib/data/context";
import { friendlyError } from "@/lib/errors";
import { clinicianName, MODERATION_LABEL } from "@/lib/format";
import { formatDate } from "@/lib/time";
import { MODERATION_STATUSES, type Facility, type ModerationStatus } from "@/types/db";

function Ratings({ clinic }: { clinic: Facility }) {
  const api = useApi();
  const qc = useQueryClient();
  const [status, setStatus] = useState<ModerationStatus | "">("");
  const [busy, setBusy] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["ratings", "moderation", clinic.id, status],
    queryFn: async () => {
      const [ratings, clinicians] = await Promise.all([
        api.listRatings(status ? { status } : {}),
        api.listClinicians(),
      ]);
      return { ratings: ratings.filter((r) => r.appointment?.facility_id === clinic.id), clinicians };
    },
  });

  const moderate = async (id: string, next: ModerationStatus) => {
    setBusy(id);
    try {
      await api.moderateRating(id, next);
      await qc.invalidateQueries({ queryKey: ["ratings"] });
      toast.success(`Rating set to ${MODERATION_LABEL[next].toLowerCase()}`);
    } catch (err) {
      toast.error(friendlyError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader title="Rating moderation" description={clinic.name} />
      <Alert className="mb-4">
        <AlertTitle>Hide or flag only abusive or clinical content</AlertTitle>
        <AlertDescription>
          Never hide a rating for being negative. Hidden and flagged ratings are left out of star averages. Comments are
          never shown publicly in Part A.
        </AlertDescription>
      </Alert>
      <Field label="Show" className="mb-4 w-56">
        <NativeSelect value={status} onChange={(e) => setStatus(e.target.value as ModerationStatus | "")}>
          <option value="">All ratings</option>
          {MODERATION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {MODERATION_LABEL[s]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <QueryView query={query}>
        {({ ratings, clinicians }) =>
          ratings.length === 0 ? (
            <EmptyState title="No ratings to show" />
          ) : (
            <ul className="grid gap-3">
              {ratings.map((r) => {
                const c = clinicians.find((x) => x.id === r.clinician_id);
                return (
                  <li key={r.id}>
                    <Card>
                      <CardContent className="grid gap-3 pt-6">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <h2 className="font-semibold">{c ? clinicianName(c) : "Clinician"}</h2>
                            <p className="text-sm text-muted-foreground">
                              Visit {r.appointment ? formatDate(r.appointment.scheduled_start, clinic.timezone) : "—"}
                              {r.is_anonymous ? " · Anonymous" : ""}
                            </p>
                          </div>
                          <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium">
                            {MODERATION_LABEL[r.moderation_status]}
                          </span>
                        </div>
                        <StarDisplay value={r.rating} />
                        {r.comment ? (
                          <blockquote className="border-l-2 pl-3 text-sm whitespace-pre-wrap">{r.comment}</blockquote>
                        ) : (
                          <p className="text-sm text-muted-foreground">No comment.</p>
                        )}
                        <div className="flex flex-wrap gap-2" role="group" aria-label="Moderation">
                          {MODERATION_STATUSES.filter((s) => s !== r.moderation_status).map((s) => (
                            <Button
                              key={s}
                              size="sm"
                              variant={s === "visible" ? "outline" : "secondary"}
                              disabled={busy === r.id}
                              onClick={() => moderate(r.id, s)}
                            >
                              {s === "visible" ? "Make visible" : s === "hidden" ? "Hide" : "Flag"}
                            </Button>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  </li>
                );
              })}
            </ul>
          )
        }
      </QueryView>
    </>
  );
}

export default function StaffRatingsPage() {
  return <RequireClinic>{(clinic) => <Ratings clinic={clinic} />}</RequireClinic>;
}
