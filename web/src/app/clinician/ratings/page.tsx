"use client";
// My ratings (5.3): get_my_ratings_as_clinician(). Anonymous ratings carry no
// patient name.
import { useQuery } from "@tanstack/react-query";
import { StarDisplay } from "@/components/star-rating";
import { EmptyState, PageHeader, QueryView } from "@/components/states";
import { Card, CardContent } from "@/components/ui/card";
import { useApi } from "@/lib/data/context";
import { formatPercent } from "@/lib/reports";
import { useMe } from "@/lib/hooks/use-me";
import { formatDate, userTimeZone } from "@/lib/time";

export default function MyRatingsPage() {
  const api = useApi();
  const me = useMe();
  const clinicianId = me.data?.clinician?.id ?? "";
  const query = useQuery({
    queryKey: ["ratings", "mine-as-clinician", clinicianId],
    queryFn: async () => {
      const [ratings, summary] = await Promise.all([api.getMyRatingsAsClinician(), api.getRatingSummary(clinicianId)]);
      return { ratings, summary: summary[0] ?? null };
    },
    enabled: !!clinicianId,
  });
  const tz = userTimeZone();

  return (
    <>
      <PageHeader title="My ratings" description="Feedback from your patients. Ratings hidden by the clinic for abusive or clinical content are not shown." />
      <QueryView query={query}>
        {({ ratings, summary }) => (
          <div className="grid gap-4">
            {summary ? (
              <Card>
                <CardContent className="grid gap-2 pt-6 sm:grid-cols-3">
                  <div>
                    <h2 className="text-sm font-medium text-muted-foreground">Overall</h2>
                    <StarDisplay value={summary.avg_rating} count={summary.rating_count} />
                  </div>
                  <div>
                    <h2 className="text-sm font-medium text-muted-foreground">Communication</h2>
                    <StarDisplay value={summary.avg_communication} />
                  </div>
                  <div>
                    <h2 className="text-sm font-medium text-muted-foreground">Would recommend</h2>
                    <p className="text-sm">
                      {summary.pct_would_recommend === null ? "—" : formatPercent(summary.pct_would_recommend / 100)}
                    </p>
                  </div>
                </CardContent>
              </Card>
            ) : null}
            {ratings.length === 0 ? (
              <EmptyState title="No ratings yet" />
            ) : (
              <ul className="grid gap-3">
                {ratings.map((r) => (
                  <li key={r.rating_id}>
                    <Card>
                      <CardContent className="grid gap-2 pt-6">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-medium">{r.patient_display_name ?? "Anonymous patient"}</p>
                          <p className="text-sm text-muted-foreground">Visit {formatDate(r.visit_date, tz)}</p>
                        </div>
                        <StarDisplay value={r.rating} />
                        <p className="text-sm text-muted-foreground">
                          Communication {r.rating_communication ?? "—"}/5 · Wait time {r.rating_wait_time ?? "—"}/5 · Would
                          recommend: {r.would_recommend === null ? "not answered" : r.would_recommend ? "yes" : "no"}
                        </p>
                        {r.comment ? <blockquote className="border-l-2 pl-3 text-sm whitespace-pre-wrap">{r.comment}</blockquote> : null}
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </QueryView>
    </>
  );
}
