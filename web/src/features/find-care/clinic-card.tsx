"use client";
import { CalendarCheck2, CalendarX2, Clock, Phone } from "lucide-react";
import Link from "next/link";
import { StarDisplay } from "@/components/star-rating";
import { Button } from "@/components/ui/button";
import { BILLING_POLICY_LABEL, CLINICIAN_TYPE_LABEL, clinicianName, clinicianShortName, FACILITY_TYPE_LABEL } from "@/lib/format";
import { formatKm } from "@/lib/geo";
import { formatDateTime } from "@/lib/time";
import { AVAILABILITY_LEGEND, type Availability, type ClinicEntry } from "./directory";

export function AvailabilityIcon({ availability }: { availability: Availability }) {
  const Icon = availability === "none" ? CalendarX2 : availability === "today" ? CalendarCheck2 : Clock;
  return <Icon className="size-4" aria-hidden="true" style={{ color: AVAILABILITY_LEGEND[availability].colour }} />;
}

export function AvailabilityLegend() {
  return (
    <ul aria-label="Map legend" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {(Object.keys(AVAILABILITY_LEGEND) as Availability[]).map((k) => (
        <li key={k} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="inline-block size-3 rounded-full border-2"
            style={{ background: AVAILABILITY_LEGEND[k].colour, borderColor: AVAILABILITY_LEGEND[k].border }}
          />
          <AvailabilityIcon availability={k} />
          <span>
            <strong>{AVAILABILITY_LEGEND[k].short}:</strong> {AVAILABILITY_LEGEND[k].label}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ClinicCard({ entry, headingLevel = 3 }: { entry: ClinicEntry; headingLevel?: 2 | 3 }) {
  const f = entry.facility;
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <article aria-labelledby={`clinic-${f.id}`} className="grid gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <H id={`clinic-${f.id}`} className="text-base font-semibold">
            {f.name}
          </H>
          <p className="text-sm text-muted-foreground">
            {f.address_line1}, {f.suburb} {f.state} {f.postcode}
            {entry.distanceKm !== null ? ` · ${formatKm(entry.distanceKm)} away` : ""}
          </p>
          <p className="text-sm">
            {FACILITY_TYPE_LABEL[f.facility_type]}
            {entry.billing ? ` · ${BILLING_POLICY_LABEL[entry.billing]}` : ""}
          </p>
        </div>
        <span className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium">
          <AvailabilityIcon availability={entry.availability} />
          {AVAILABILITY_LEGEND[entry.availability].short}
        </span>
      </div>
      <p className="text-sm">
        <strong>Next available:</strong>{" "}
        {entry.nextAvailable ? formatDateTime(entry.nextAvailable.starts_at, f.timezone) : "Nothing in the next 7 days"}
      </p>
      {f.phone ? (
        <p className="flex items-center gap-1 text-sm">
          <Phone className="size-4" aria-hidden="true" />
          <a href={`tel:${f.phone.replace(/\s/g, "")}`} className="underline-offset-2 hover:underline">
            {f.phone}
          </a>
        </p>
      ) : null}
      <ul className="grid gap-2" aria-label={`Clinicians at ${f.name}`}>
        {entry.clinicians.map(({ clinician: c, qualifications, rating, nextAvailable }) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
            <div className="grid gap-0.5">
              <span className="font-medium">{clinicianName(c)}</span>
              <span className="text-sm text-muted-foreground">
                {CLINICIAN_TYPE_LABEL[c.clinician_type]}
                {c.specialty ? ` · ${c.specialty}` : ""}
                {qualifications.length ? ` · ${qualifications.join(", ")}` : ""}
              </span>
              <StarDisplay value={rating?.avg_rating ?? null} count={rating ? Number(rating.rating_count) : undefined} />
            </div>
            <Button asChild size="sm" variant={nextAvailable ? "default" : "outline"}>
              <Link href={`/patient/book/${c.id}?facility=${f.id}`}>Book with {clinicianShortName(c)}</Link>
            </Button>
          </li>
        ))}
        {entry.clinicians.length === 0 ? <li className="text-sm text-muted-foreground">No clinicians listed today.</li> : null}
      </ul>
    </article>
  );
}
