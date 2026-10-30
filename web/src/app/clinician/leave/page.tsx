"use client";
// My leave (5.4): the clinician's own schedule_exceptions (RLS allows it).
// Slots are blocked automatically; bookings that clash are listed.
import { useQuery } from "@tanstack/react-query";
import { PageHeader, QueryView } from "@/components/states";
import { affiliatedClinics } from "@/features/clinician/home-clinic";
import { ExceptionsPanel } from "@/features/schedules/exceptions-panel";
import { useApi } from "@/lib/data/context";
import { useMe } from "@/lib/hooks/use-me";
import { todayUtc } from "@/lib/time";

export default function MyLeavePage() {
  const api = useApi();
  const me = useMe();
  const clinician = me.data?.clinician ?? null;
  const query = useQuery({
    queryKey: ["clinician-clinics", clinician?.id],
    queryFn: async () => {
      const [affiliations, facilities] = await Promise.all([api.listAffiliations(clinician!.id), api.listFacilities()]);
      return affiliatedClinics(affiliations, facilities, todayUtc());
    },
    enabled: !!clinician,
  });

  return (
    <>
      <PageHeader
        title="My leave"
        description="Times you're unavailable. Your slots in that time are blocked straight away. Bookings that clash need to be moved by the clinic."
      />
      <QueryView query={query}>
        {(clinics) =>
          clinician ? (
            <ExceptionsPanel
              clinicians={[clinician]}
              facilities={clinics}
              timeZone={clinics[0]?.timezone ?? "Australia/Brisbane"}
              allowExtraSessions={false}
              defaultFacilityId=""
            />
          ) : null
        }
      </QueryView>
    </>
  );
}
