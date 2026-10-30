"use client";
import { useQueries, useQuery } from "@tanstack/react-query";
import { MapPinOff } from "lucide-react";
import { useMemo, useState } from "react";
import { EmergencyBanner } from "@/components/emergency-banner";
import { Field } from "@/components/form-field";
import { NativeSelect } from "@/components/native-select";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { containsEmergencyWords } from "@/config/emergency";
import { AvailabilityLegend, ClinicCard } from "@/features/find-care/clinic-card";
import { ClinicMap } from "@/features/find-care/clinic-map";
import { useFindCare } from "@/features/find-care/context";
import { buildDirectory, sortDirectory, type SortKey } from "@/features/find-care/directory";
import { LocationPicker, RadiusInput } from "@/features/find-care/location-picker";
import { useApi } from "@/lib/data/context";
import { GOOGLE_MAPS_KEY } from "@/lib/env";
import { haversineKm } from "@/lib/geo";
import { addDays, localDate } from "@/lib/time";
import type { AvailableSlot } from "@/types/db";

const BRISBANE = { lat: -27.4698, lng: 153.0251 };

function useDirectoryData() {
  const api = useApi();
  return useQuery({
    queryKey: ["directory"],
    queryFn: async () => {
      const [facilities, affiliations, clinicians, billing, qualifications, ratings] = await Promise.all([
        api.listFacilities(),
        api.listAffiliations(),
        api.listClinicians(),
        api.listBillingPolicies(),
        api.listQualifications(),
        api.getRatingSummary(null),
      ]);
      return { facilities, affiliations, clinicians, billing, qualifications, ratings };
    },
    staleTime: 5 * 60_000,
  });
}

export default function FindPage() {
  const api = useApi();
  const { location, radiusKm, reason } = useFindCare();
  const [sort, setSort] = useState<SortKey>("distance");
  const directory = useDirectoryData();

  const inRange = useMemo(
    () =>
      (directory.data?.facilities ?? []).filter(
        (f) =>
          f.is_active &&
          f.latitude !== null &&
          f.longitude !== null &&
          (!location || haversineKm(location, { lat: f.latitude, lng: f.longitude }) <= radiusKm),
      ),
    [directory.data, location, radiusKm],
  );

  // One get_available_slots call per day for the next 7 days, per clinic.
  const availability = useQueries({
    queries: inRange.map((f) => ({
      queryKey: ["availability-7d", f.id, localDate(new Date(), f.timezone)],
      queryFn: async () => {
        const today = localDate(new Date(), f.timezone);
        const days = await Promise.all(
          Array.from({ length: 7 }, (_, i) => api.getAvailableSlots({ date: addDays(today, i), facilityId: f.id })),
        );
        return days.flat();
      },
      staleTime: 60_000,
    })),
  });

  const slotsByFacility = Object.fromEntries(inRange.map((f, i) => [f.id, availability[i]?.data])) as Record<
    string,
    AvailableSlot[] | undefined
  >;
  const loadingSlots = availability.some((q) => q.isPending);

  const entries = directory.data
    ? sortDirectory(buildDirectory({ ...directory.data, slotsByFacility, location, radiusKm }), sort)
    : [];

  return (
    <div className="grid gap-6">
      <PageHeader title="Find a clinic" description="Clinics near you, their clinicians and their next available times." />
      {containsEmergencyWords(reason) ? <EmergencyBanner /> : null}
      <Card>
        <CardContent className="flex flex-wrap items-start gap-6 pt-6">
          <RadiusInput />
          <LocationPicker />
        </CardContent>
      </Card>

      <AvailabilityLegend />

      {directory.isPending ? <LoadingState label="Loading clinics…" /> : null}
      {directory.isError ? <ErrorState error={directory.error} onRetry={() => void directory.refetch()} /> : null}

      {directory.data ? (
        <>
          {GOOGLE_MAPS_KEY ? (
            <ClinicMap entries={entries} centre={location ?? BRISBANE} />
          ) : (
            <Alert>
              <MapPinOff aria-hidden="true" />
              <AlertDescription>
                The map needs a Google Maps API key (NEXT_PUBLIC_GOOGLE_MAPS_KEY), so clinics are shown as a list.
              </AlertDescription>
            </Alert>
          )}

          <section aria-labelledby="clinic-list-title" className="grid gap-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2 id="clinic-list-title" className="text-lg font-semibold">
                {entries.length} clinic{entries.length === 1 ? "" : "s"}
                {location ? ` within ${radiusKm} km` : ""}
              </h2>
              <Field label="Sort by" className="w-52">
                <NativeSelect value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                  <option value="distance">Distance</option>
                  <option value="next">Next available</option>
                  <option value="rating">Rating</option>
                </NativeSelect>
              </Field>
            </div>
            {loadingSlots ? <LoadingState label="Checking availability for the next 7 days…" /> : null}
            {entries.length === 0 ? (
              <EmptyState title="No clinics in this area">Try a larger distance or a different suburb.</EmptyState>
            ) : (
              <ul className="grid gap-4 lg:grid-cols-2">
                {entries.map((e) => (
                  <li key={e.facility.id}>
                    <Card>
                      <CardContent className="pt-6">
                        <ClinicCard entry={e} />
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
