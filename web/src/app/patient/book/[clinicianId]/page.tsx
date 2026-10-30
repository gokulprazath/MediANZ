"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { EmptyState, PageHeader, QueryView } from "@/components/states";
import { StarDisplay } from "@/components/star-rating";
import { Button } from "@/components/ui/button";
import { BookingFlow } from "@/features/booking/booking-flow";
import { useApi } from "@/lib/data/context";
import { BILLING_POLICY_LABEL, CLINICIAN_TYPE_LABEL, clinicianName, formatRating } from "@/lib/format";
import { currentRow } from "@/lib/history";
import { useMe } from "@/lib/hooks/use-me";
import { formatDateTime, localDate } from "@/lib/time";

function BookInner() {
  const api = useApi();
  const me = useMe();
  const { clinicianId } = useParams<{ clinicianId: string }>();
  const params = useSearchParams();
  const facilityId = params.get("facility");
  const rescheduleId = params.get("reschedule");

  const data = useQuery({
    queryKey: ["book-context", clinicianId, facilityId, rescheduleId],
    queryFn: async () => {
      const [clinicians, facilities, billing, ratings, current] = await Promise.all([
        api.listClinicians(),
        api.listFacilities(),
        api.listBillingPolicies(),
        api.getRatingSummary(clinicianId),
        rescheduleId ? api.getAppointment(rescheduleId) : Promise.resolve(null),
      ]);
      return {
        clinician: clinicians.find((c) => c.id === clinicianId) ?? null,
        facility: facilities.find((f) => f.id === facilityId) ?? null,
        billing,
        rating: ratings[0] ?? null,
        current,
      };
    },
  });

  return (
    <QueryView query={data}>
      {({ clinician, facility, billing, rating, current }) => {
        if (!clinician || !facility || !me.data?.patient) {
          return (
            <EmptyState title="That clinician or clinic wasn't found">
              <Button asChild variant="link">
                <Link href="/patient/find">Back to Find care</Link>
              </Button>
            </EmptyState>
          );
        }
        const policy = currentRow(
          billing.filter((b) => b.facility_id === facility.id),
          localDate(new Date(), facility.timezone),
        );
        return (
          <div className="grid gap-6">
            <PageHeader
              title={current ? `Reschedule with ${clinicianName(clinician)}` : `Book with ${clinicianName(clinician)}`}
              description={
                <>
                  {CLINICIAN_TYPE_LABEL[clinician.clinician_type]}
                  {clinician.specialty ? ` · ${clinician.specialty}` : ""} · {facility.name}, {facility.suburb}
                  {policy ? ` · ${BILLING_POLICY_LABEL[policy.billing_policy]}` : ""}
                </>
              }
            />
            {rating ? <StarDisplay value={rating.avg_rating} count={Number(rating.rating_count)} /> : null}
            {current ? (
              <p className="rounded-md border p-3 text-sm">
                Current time: <strong>{formatDateTime(current.scheduled_start, current.facility.timezone)}</strong>. Pick a new
                time below; the current one is released when you confirm.
              </p>
            ) : null}
            <BookingFlow clinician={clinician} facility={facility} patientId={me.data.patient.id} rescheduleId={current?.id ?? null} />
            <p className="sr-only">Average rating {formatRating(rating?.avg_rating)}</p>
          </div>
        );
      }}
    </QueryView>
  );
}

export default function BookPage() {
  return (
    <Suspense>
      <BookInner />
    </Suspense>
  );
}
