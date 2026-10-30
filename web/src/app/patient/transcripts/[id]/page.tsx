"use client";
// Transcript review (4.6): a draft can be approved or rejected before its
// review period ends; an approved transcript is read-only.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { EmptyState, PageHeader, QueryView } from "@/components/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatOffset, speakerTurns } from "@/features/consult/transcript";
import { useApi } from "@/lib/data/context";
import { friendlyError } from "@/lib/errors";
import { clinicianName } from "@/lib/format";
import { formatDateTime, userTimeZone } from "@/lib/time";

export default function TranscriptPage() {
  const api = useApi();
  const qc = useQueryClient();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [busy, setBusy] = useState(false);
  const [openedAt] = useState(() => Date.now());
  const query = useQuery({
    queryKey: ["transcript", id],
    queryFn: async () => {
      const t = await api.getTranscript(id);
      const a = t ? await api.getAppointment(t.appointment_id) : null;
      return { t, a };
    },
  });

  const done = async () => {
    await qc.invalidateQueries({ queryKey: ["transcript", id] });
    await qc.invalidateQueries({ queryKey: ["transcripts"] });
    await qc.invalidateQueries({ queryKey: ["recordings"] });
  };

  return (
    <QueryView query={query}>
      {({ t, a }) => {
        if (!t) {
          return (
            <EmptyState title="Transcript not found">
              It may have been rejected, withdrawn or deleted after its review period.{" "}
              <Link className="underline" href="/patient/profile#recordings">
                My recordings and transcripts
              </Link>
            </EmptyState>
          );
        }
        const tz = a?.facility.timezone ?? userTimeZone();
        const draft = t.status === "pending_patient_review";
        const expired = draft && Date.parse(t.review_expires_at) < openedAt;
        return (
          <div className="mx-auto grid max-w-3xl gap-6">
            <PageHeader
              title={draft ? "Review your transcript" : "Consultation transcript"}
              description={a ? `${formatDateTime(a.scheduled_start, tz)} with ${clinicianName(a.clinician)}` : undefined}
            />
            {draft ? (
              <Alert>
                <AlertTitle>{expired ? "The review period has ended" : "This is a draft only you can see"}</AlertTitle>
                <AlertDescription>
                  {expired
                    ? "This draft will be deleted."
                    : `Approve it to share it with your clinician, or reject it to delete it. Review by ${formatDateTime(t.review_expires_at, tz)}; after that it is deleted.`}
                </AlertDescription>
              </Alert>
            ) : (
              <p className="text-sm text-muted-foreground">
                Approved {t.approved_at ? formatDateTime(t.approved_at, tz) : ""}. Your clinician can see this transcript.
              </p>
            )}
            <Card>
              <CardContent className="pt-6">
                <ol className="grid gap-4" aria-label="Transcript">
                  {speakerTurns(t).map((turn, i) => (
                    <li key={i} className="grid gap-1">
                      <p className="text-sm font-semibold">
                        {turn.speaker}
                        {turn.startSec !== null ? (
                          <span className="ml-2 font-normal text-muted-foreground tabular-nums">{formatOffset(turn.startSec)}</span>
                        ) : null}
                      </p>
                      <p className="whitespace-pre-wrap">{turn.text}</p>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
            {draft && !expired ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api.approveTranscript(t.id);
                      await done();
                      toast.success("Transcript approved");
                    } catch (err) {
                      toast.error(friendlyError(err));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Approve
                </Button>
                <ConfirmAction
                  trigger="Reject"
                  variant="outline"
                  title="Reject and delete this transcript?"
                  description="The draft is deleted straight away and can't be recovered. Your clinician will not see it."
                  confirmLabel="Reject transcript"
                  disabled={busy}
                  onConfirm={async () => {
                    try {
                      await api.rejectTranscript(t.id);
                      await done();
                      toast.success("Transcript rejected and deleted");
                      router.replace("/patient/profile#recordings");
                    } catch (err) {
                      toast.error(friendlyError(err));
                      throw err;
                    }
                  }}
                />
              </div>
            ) : null}
          </div>
        );
      }}
    </QueryView>
  );
}
