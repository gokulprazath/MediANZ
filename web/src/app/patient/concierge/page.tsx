"use client";
// AI care finder (Part B, B4/B5): describe the problem in your own words; the
// discovery service matches it to a service, finds clinicians nearby with a
// free time, estimates your out-of-pocket cost with Medicare and your
// insurance, and ranks them. The patient picks a time and confirms; the
// booking only happens on that tap (hold -> book with the quoted gap, so a
// changed price is never booked silently). The problem text stays in memory.
import { useQueryClient } from "@tanstack/react-query";
import { Clock, MapPin, Sparkles, Star } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { EmergencyBanner } from "@/components/emergency-banner";
import { Field } from "@/components/form-field";
import { EmptyState, PageHeader } from "@/components/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import { containsEmergencyWords } from "@/config/emergency";
import { COVERAGE_LABEL, FACTOR_LABEL, FLAG_LABEL, moneyText, REASON_LABEL } from "@/features/concierge/format";
import { useFindCare } from "@/features/find-care/context";
import { LocationPicker, RadiusInput } from "@/features/find-care/location-picker";
import { AgentError, agentErrorMessage, agents } from "@/lib/agents/client";
import type { ClinicCard, DiscoveryResponse, FactorScores, ProviderOption } from "@/lib/agents/types";
import { formatCountdown, formatDateTime } from "@/lib/time";

interface Held {
  card: ClinicCard;
  option: ProviderOption;
  heldUntil: number;
  gap: string | null;
  key: string; // idempotency key: a retry of the same tap never books twice
}

function Factors({ factors }: { factors: FactorScores }) {
  return (
    <dl className="grid gap-2 sm:grid-cols-2">
      {(Object.keys(FACTOR_LABEL) as (keyof FactorScores)[]).map((k) => (
        <div key={k} className="grid gap-1">
          <dt className="flex justify-between text-xs">
            <span>{FACTOR_LABEL[k]}</span>
            <span className="tabular-nums">{Math.round(factors[k] * 100)}/100</span>
          </dt>
          <dd>
            <Progress value={factors[k] * 100} aria-label={`${FACTOR_LABEL[k]}: ${Math.round(factors[k] * 100)} out of 100`} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function OptionCost({ option }: { option: ProviderOption }) {
  const ins = option.insurance;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
      <dt className="text-muted-foreground">Fee</dt>
      <dd className="tabular-nums">{moneyText(option.fee)}</dd>
      <dt className="text-muted-foreground">Medicare rebate</dt>
      <dd className="tabular-nums">{moneyText(option.medicare_rebate)}</dd>
      {ins.insurance_benefit !== null && Number(ins.insurance_benefit) > 0 ? (
        <>
          <dt className="text-muted-foreground">Insurance pays</dt>
          <dd className="tabular-nums">{moneyText(ins.insurance_benefit)}</dd>
        </>
      ) : null}
      <dt className="font-medium">You pay (estimate)</dt>
      <dd className="font-semibold tabular-nums">{moneyText(ins.gap)}</dd>
    </dl>
  );
}

function ClinicResult({ card, onBook, busy }: { card: ClinicCard; onBook: (card: ClinicCard, option: ProviderOption) => void; busy: boolean }) {
  const o = card.primary_option;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h3 className="flex flex-wrap items-center gap-2 text-lg">
            <span className="flex size-7 items-center justify-center rounded-full bg-primary text-sm text-primary-foreground" aria-label={`Rank ${card.rank}`}>
              {card.rank}
            </span>
            {card.facility_name}
            {card.flags.map((f) => (
              <Badge key={f} variant="secondary">
                {FLAG_LABEL[f] ?? f}
              </Badge>
            ))}
          </h3>
        </CardTitle>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span className="flex items-center gap-1">
            <MapPin className="size-4" aria-hidden="true" />
            {card.address_line1}, {card.suburb} · {card.distance_km.toFixed(1)} km
          </span>
          {card.rating !== null ? (
            <span className="flex items-center gap-1">
              <Star className="size-4 fill-amber-400 text-amber-500" aria-hidden="true" />
              {card.rating.toFixed(1)} out of 5 ({card.review_count})
            </span>
          ) : null}
          <span>Match {Math.round(card.score * 100)}%</span>
        </p>
      </CardHeader>
      <CardContent className="grid gap-4">
        {card.agent_description ? (
          <p className="flex gap-2 rounded-md bg-accent p-3 text-sm">
            <Sparkles className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              <span className="font-medium">AI summary: </span>
              {card.agent_description}
            </span>
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1">
            <p className="font-medium">
              {o.clinician_name}
              {o.specialty ? <span className="font-normal text-muted-foreground"> · {o.specialty}</span> : null}
            </p>
            <p className="flex items-center gap-1 text-sm">
              <Clock className="size-4" aria-hidden="true" />
              Next: {formatDateTime(o.next_slot_start, card.timezone)}
            </p>
            {o.languages.length ? <p className="text-sm text-muted-foreground">Languages: {o.languages.join(", ").toUpperCase()}</p> : null}
            {o.offers_telehealth ? <p className="text-sm text-muted-foreground">Offers telehealth</p> : null}
          </div>
          <OptionCost option={o} />
        </div>
        <div className="text-sm">
          <p className="font-medium">{COVERAGE_LABEL[o.insurance.coverage_status]}</p>
          {o.insurance.reason_codes.map((r) => (REASON_LABEL[r] ? <p key={r} className="text-muted-foreground">{REASON_LABEL[r]}</p> : null))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => onBook(card, o)} disabled={busy}>
            Book {formatDateTime(o.next_slot_start, card.timezone)}
          </Button>
          <Button asChild variant="outline">
            <Link href={`/patient/book/${o.clinician_id}?facility=${card.facility_id}`}>Other times</Link>
          </Button>
        </div>
        <details>
          <summary className="cursor-pointer text-sm font-medium">Why this clinic?</summary>
          <div className="grid gap-4 pt-3">
            <Factors factors={o.factors} />
            {card.options.length > 1 ? (
              <div className="grid gap-2">
                <p className="text-sm font-medium">Other clinicians here</p>
                <ul className="grid gap-2">
                  {card.options.slice(1).map((x) => (
                    <li key={x.clinician_id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm">
                      <span>
                        {x.clinician_name} · {formatDateTime(x.next_slot_start, card.timezone)} · you pay {moneyText(x.insurance.gap)}
                      </span>
                      <Button size="sm" variant="outline" onClick={() => onBook(card, x)} disabled={busy}>
                        Book this
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

function HoldPanel({ held, reason, onDone, onCancel }: { held: Held; reason: string; onDone: (id: string) => void; onCancel: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [gap, setGap] = useState(held.gap);
  const [changed, setChanged] = useState<string | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const remaining = held.heldUntil - now;
  const book = async () => {
    setBusy(true);
    try {
      const res = await agents.book({
        slot_id: held.option.next_slot_id,
        service_code: held.card.service_code,
        reason: reason.trim() || null,
        idempotency_key: held.key,
        expected_fee: held.option.fee,
        expected_gap: gap,
      });
      toast.success("Booked");
      onDone(res.appointment_id);
    } catch (err) {
      if (err instanceof AgentError && err.code === "QUOTE_CHANGED") {
        setChanged(err.body.current_gap ?? null);
        setGap(err.body.current_gap ?? null);
      } else {
        toast.error(agentErrorMessage(err));
        if (err instanceof AgentError && err.code === "SLOT_TAKEN") onCancel();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="border-primary" role="region" aria-labelledby="confirm-title">
      <CardHeader>
        <CardTitle>
          <h2 id="confirm-title" className="text-lg">
            Confirm your booking
          </h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p>
          <strong>{formatDateTime(held.option.next_slot_start, held.card.timezone)}</strong> with {held.option.clinician_name} at{" "}
          {held.card.facility_name}, {held.card.suburb}.
        </p>
        <p className="text-sm">
          Estimated cost to you: <strong>{moneyText(gap)}</strong>. {held.option.insurance.disclaimer}
        </p>
        {changed !== null ? (
          <Alert variant="destructive">
            <AlertTitle>The price changed</AlertTitle>
            <AlertDescription>The clinic&apos;s estimate is now {moneyText(changed)}. Tap Confirm again to book at this price.</AlertDescription>
          </Alert>
        ) : null}
        <p className="text-sm" role="timer" aria-live="off">
          We&apos;re holding this time for <strong>{formatCountdown(remaining)}</strong>.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void book()} disabled={busy || remaining <= 0}>
            {busy ? "Booking…" : "Confirm booking"}
          </Button>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Choose another
          </Button>
        </div>
        {remaining <= 0 ? <p role="alert">The hold has ended. Please choose a time again.</p> : null}
      </CardContent>
    </Card>
  );
}

export default function ConciergePage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { reason, setReason, radiusKm, location } = useFindCare();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DiscoveryResponse | null>(null);
  const [clarify, setClarify] = useState<{ code: string; name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [held, setHeld] = useState<Held | null>(null);

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
    } catch (err) {
      setResult(null);
      if (err instanceof AgentError && err.code === "NEEDS_SERVICE_CLARIFICATION") setClarify(err.body.candidates ?? []);
      else setError(agentErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const hold = async (card: ClinicCard, option: ProviderOption) => {
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

  return (
    <div className="mx-auto grid max-w-4xl gap-6">
      <PageHeader
        title="AI care finder"
        description="Describe what you need. Our agents match it to a service, find clinicians near you with a free time, and estimate what you'll pay after Medicare and your insurance."
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
            <div className="grid gap-4">
              <Field label="What do you need help with?" hint="In your own words, e.g. “a skin check for a mole” or “repeat prescription”. Used to find the right service and saved as the booking reason.">
                <Textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
              <div className="flex flex-wrap items-end gap-4">
                <RadiusInput />
              </div>
              <LocationPicker />
              <div>
                <Button type="button" onClick={() => void search()} disabled={busy || !location || !reason.trim()}>
                  <Sparkles aria-hidden="true" />
                  {busy ? "Finding care…" : "Find care"}
                </Button>
                {!location ? <p className="mt-2 text-sm text-muted-foreground">Share your location or choose a suburb first.</p> : null}
              </div>
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

      {result && !held ? (
        <section aria-labelledby="results-title" className="grid gap-4">
          <div>
            <h2 id="results-title" className="text-xl font-semibold">
              {result.clinics.length ? `Best matches for ${result.service.name.toLowerCase()}` : "No matches"}
            </h2>
            <p className="text-sm text-muted-foreground">
              {result.candidate_count} clinician{result.candidate_count === 1 ? "" : "s"} within {result.search_radius_km} km with a free time.
              Ranked by how soon, cost to you, distance, insurance, ratings and your preferences.
            </p>
          </div>
          {result.clinics.length === 0 ? (
            <EmptyState title="No clinicians with free times nearby">Try a larger distance, or another service.</EmptyState>
          ) : (
            result.clinics.map((c) => <ClinicResult key={c.facility_id} card={c} onBook={(card, o) => void hold(card, o)} busy={busy} />)
          )}
          <p className="text-xs text-muted-foreground">
            Costs are estimates from the clinic&apos;s fees, the Medicare rebate and public insurance information. Confirm with
            the clinic and your insurer. AI summaries describe availability and cost only; they are not medical advice.
          </p>
        </section>
      ) : null}
    </div>
  );
}
