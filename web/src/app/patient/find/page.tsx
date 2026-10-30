"use client";
// Find care: the AI care finder and the clinic map on one page. Describe the
// problem and the discovery service matches it to a service, ranks clinicians
// nearby by cost after Medicare and insurance, wait, distance and ratings; the
// ranked clinics are numbered on the map. Or browse every clinic in range with
// its next free time. Booking only happens on the patient's Confirm. The
// problem text stays in memory.
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPinOff, Sparkles, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { EmergencyBanner } from "@/components/emergency-banner";
import { Field } from "@/components/form-field";
import { NativeSelect } from "@/components/native-select";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { containsEmergencyWords } from "@/config/emergency";
import { ClinicResult, type Held, HoldPanel } from "@/features/concierge/results";
import { AvailabilityLegend, ClinicCard } from "@/features/find-care/clinic-card";
import { ClinicMap } from "@/features/find-care/clinic-map";
import { useFindCare } from "@/features/find-care/context";
import { buildDirectory, sortDirectory, type SortKey } from "@/features/find-care/directory";
import { LocationPicker, RadiusInput } from "@/features/find-care/location-picker";
import { AgentError, agentErrorMessage, agents } from "@/lib/agents/client";
import type { ClinicCard as AiClinicCard, DiscoveryResponse, ProviderOption } from "@/lib/agents/types";
import { useApi } from "@/lib/data/context";
import { GOOGLE_MAPS_KEY } from "@/lib/env";
import { haversineKm } from "@/lib/geo";
import { addDays, localDate } from "@/lib/time";
import type { AvailableSlot } from "@/types/db";

const BRISBANE = { lat: -27.4698, lng: 153.0251 };

type View = "ai" | "all";

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

function FindCare() {
  const api = useApi();
  const router = useRouter();
  const qc = useQueryClient();
  const autoSearch = useSearchParams().get("ai") === "1";
  const { location, radiusKm, reason, setReason } = useFindCare();
  const [sort, setSort] = useState<SortKey>("distance");
  const [view, setView] = useState<View>("all");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DiscoveryResponse | null>(null);
  const [clarify, setClarify] = useState<{ code: string; name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [held, setHeld] = useState<Held | null>(null);
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
  const ranks = Object.fromEntries((result?.clinics ?? []).map((c) => [c.facility_id, c.rank])) as Record<string, number>;

  const search = async (serviceCode?: string) => {
    if (!location) return;
    setBusy(true);
    setError(null);
    setClarify(null);
    try {
      const res = await agents.discover({
        problem_text: serviceCode ? null : reason.trim().slice(0, 500) || null,
        service_code: serviceCode ?? null,
        latitude: location.lat,
        longitude: location.lng,
        max_distance_km: radiusKm,
        limit: 10,
        include_agent_descriptions: true,
      });
      setResult(res);
      setView("ai");
    } catch (err) {
      setResult(null);
      if (err instanceof AgentError && err.code === "NEEDS_SERVICE_CLARIFICATION") setClarify(err.body.candidates ?? []);
      else setError(agentErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // From the home page's "Find care with AI": search once, as soon as we can.
  const autoRan = useRef(false);
  useEffect(() => {
    if (!autoSearch || autoRan.current || !location || !reason.trim()) return;
    autoRan.current = true;
    void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once when location and reason are ready
  }, [autoSearch, location, reason]);

  const hold = async (card: AiClinicCard, option: ProviderOption) => {
    setBusy(true);
    try {
      const res = await agents.hold(option.next_slot_id);
      setHeld({ card, option, heldUntil: Date.parse(res.held_until), gap: option.insurance.gap, key: crypto.randomUUID() });
    } catch (err) {
      toast.error(agentErrorMessage(err));
      if (err instanceof AgentError && err.code === "SLOT_TAKEN") void search(card.service_code);
    } finally {
      setBusy(false);
    }
  };

  const clearAi = () => {
    setResult(null);
    setClarify(null);
    setError(null);
    setView("all");
  };

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Find care"
        description="Describe what you need and our AI ranks clinicians near you by cost after Medicare and your insurance, wait, distance and ratings, or browse every clinic on the map."
      />
      {containsEmergencyWords(reason) ? <EmergencyBanner /> : null}

      {held ? (
        <HoldPanel
          held={held}
          reason={reason}
          onCancel={() => setHeld(null)}
          onDone={async (id) => {
            await qc.invalidateQueries({ queryKey: ["appointments"] });
            setReason("");
            router.push(`/patient/appointments/${id}/confirmed`);
          }}
        />
      ) : (
        <Card>
          <CardContent className="grid gap-4 pt-6">
            {/* Not one <form>: the location picker has its own form inside. */}
            <Field
              label="What do you need help with?"
              hint="In your own words, e.g. “a skin check for a mole” or “repeat prescription”. Used to find the right service and saved as the booking reason."
            >
              <Textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div className="flex flex-wrap items-start gap-6">
              <RadiusInput />
              <LocationPicker />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={() => void search()} disabled={busy || !location || !reason.trim()}>
                <Sparkles aria-hidden="true" />
                {busy ? "Finding care…" : "Find care with AI"}
              </Button>
              {result || clarify ? (
                <Button type="button" variant="ghost" onClick={clearAi} disabled={busy}>
                  <X aria-hidden="true" />
                  Clear AI results
                </Button>
              ) : null}
              {!location ? <p className="text-sm text-muted-foreground">Share your location or choose a suburb first.</p> : null}
            </div>
          </CardContent>
        </Card>
      )}

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {clarify ? (
        <Card role="region" aria-labelledby="clarify-title">
          <CardHeader>
            <CardTitle>
              <h2 id="clarify-title" className="text-lg">
                Which of these do you need?
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {clarify.map((c) => (
              <Button key={c.code} variant="outline" onClick={() => void search(c.code)} disabled={busy}>
                {c.name}
              </Button>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {directory.isPending ? <LoadingState label="Loading clinics…" /> : null}
      {directory.isError ? <ErrorState error={directory.error} onRetry={() => void directory.refetch()} /> : null}

      {directory.data && !held ? (
        <>
          <AvailabilityLegend />
          {GOOGLE_MAPS_KEY ? (
            <ClinicMap entries={entries} centre={location ?? BRISBANE} ranks={ranks} />
          ) : (
            <Alert>
              <MapPinOff aria-hidden="true" />
              <AlertDescription>
                The map needs a Google Maps API key (NEXT_PUBLIC_GOOGLE_MAPS_KEY), so clinics are shown as a list.
              </AlertDescription>
            </Alert>
          )}

          <Tabs value={view} onValueChange={(v) => setView(v as View)} className="grid gap-4">
            <TabsList aria-label="Results">
              <TabsTrigger value="ai" disabled={!result}>
                <Sparkles aria-hidden="true" />
                AI matches{result ? ` (${result.clinics.length})` : ""}
              </TabsTrigger>
              <TabsTrigger value="all">All clinics ({entries.length})</TabsTrigger>
            </TabsList>

            <TabsContent value="ai">
              {result ? (
                <section aria-labelledby="results-title" className="grid gap-4">
                  <div>
                    <h2 id="results-title" className="text-xl font-semibold">
                      {result.clinics.length ? `Best matches for ${result.service.name.toLowerCase()}` : "No matches"}
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      {result.candidate_count} clinician{result.candidate_count === 1 ? "" : "s"} within {result.search_radius_km} km
                      with a free time. Ranked by how soon, cost to you, distance, insurance, ratings and your preferences. The
                      numbers match the pins on the map.
                    </p>
                  </div>
                  {result.clinics.length === 0 ? (
                    <EmptyState title="No clinicians with free times nearby">Try a larger distance, or another service.</EmptyState>
                  ) : (
                    <div className="grid gap-4 lg:grid-cols-2">
                      {result.clinics.map((c) => (
                        <ClinicResult key={c.facility_id} card={c} onBook={(card, o) => void hold(card, o)} busy={busy} />
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    Costs are estimates from the clinic&apos;s fees, the Medicare rebate and public insurance information. Confirm
                    with the clinic and your insurer. AI summaries describe availability and cost only; they are not medical
                    advice.
                  </p>
                </section>
              ) : null}
            </TabsContent>

            <TabsContent value="all">
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
            </TabsContent>
          </Tabs>
        </>
      ) : null}
    </div>
  );
}

export default function FindPage() {
  return (
    <Suspense>
      <FindCare />
    </Suspense>
  );
}
