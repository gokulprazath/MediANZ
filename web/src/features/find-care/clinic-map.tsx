"use client";
// Google Map of clinics. Each pin has a coloured flag AND a text label (and an
// icon), so colour is never the only cue. Hover or tap opens the clinic card.
// After an AI search, ranked clinics show their rank and the map zooms to them;
// the other clinics stay visible but faded.
import { AdvancedMarker, APIProvider, InfoWindow, Map, useAdvancedMarkerRef, useMap } from "@vis.gl/react-google-maps";
import { useEffect, useState } from "react";
import { GOOGLE_MAPS_KEY, GOOGLE_MAPS_MAP_ID } from "@/lib/env";
import type { LatLng } from "@/lib/geo";
import { cn } from "@/lib/utils";
import { AvailabilityIcon, ClinicCard } from "./clinic-card";
import { AVAILABILITY_LEGEND, type ClinicEntry } from "./directory";

function ClinicPin({
  entry,
  rank,
  faded,
  open,
  onOpen,
  onClose,
}: {
  entry: ClinicEntry;
  rank: number | undefined;
  faded: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const [ref, marker] = useAdvancedMarkerRef();
  const legend = AVAILABILITY_LEGEND[entry.availability];
  const label = `${rank ? `#${rank} ` : ""}${entry.facility.name.split(" ")[0]} · ${legend.short}`;
  return (
    <>
      <AdvancedMarker
        ref={ref}
        position={{ lat: entry.facility.latitude!, lng: entry.facility.longitude! }}
        // The accessible name starts with the visible label (WCAG 2.5.3).
        title={`${label}. ${entry.facility.name}: ${legend.label}${rank ? `, AI match ${rank}` : ""}`}
        zIndex={rank ? 1000 - rank : undefined}
        onClick={onOpen}
        onMouseEnter={onOpen}
      >
        <div
          className={cn(
            "flex items-center gap-1 rounded-full border-2 bg-white px-2 py-1 text-xs font-semibold text-gray-900 shadow transition-opacity",
            faded && "opacity-55",
            rank && "border-primary bg-primary text-primary-foreground",
          )}
          style={rank ? undefined : { borderColor: legend.border }}
        >
          <span aria-hidden="true" className="inline-block size-3 rounded-full" style={{ background: legend.colour }} />
          <AvailabilityIcon availability={entry.availability} />
          <span>{label}</span>
        </div>
      </AdvancedMarker>
      {open ? (
        <InfoWindow anchor={marker} onCloseClick={onClose} maxWidth={360} headerDisabled={false}>
          <div className="text-gray-900">
            <ClinicCard entry={entry} />
          </div>
        </InfoWindow>
      ) : null}
    </>
  );
}

// Zoom to the ranked clinics when an AI search returns, else to every pin.
function FitBounds({ points }: { points: LatLng[] }) {
  const map = useMap();
  const key = points.map((p) => `${p.lat},${p.lng}`).join("|");
  useEffect(() => {
    if (!map || points.length === 0) return;
    if (points.length === 1) {
      map.panTo(points[0]);
      map.setZoom(14);
      return;
    }
    const bounds = new google.maps.LatLngBounds();
    for (const p of points) bounds.extend(p);
    map.fitBounds(bounds, 64);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refit only when the set of points changes
  }, [map, key]);
  return null;
}

export function ClinicMap({
  entries,
  centre,
  ranks = {},
}: {
  entries: ClinicEntry[];
  centre: LatLng;
  ranks?: Record<string, number>; // facility id -> AI rank
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (!GOOGLE_MAPS_KEY) return null;
  const ranked = entries.filter((e) => ranks[e.facility.id] !== undefined);
  const focus = (ranked.length ? ranked : entries).map((e) => ({ lat: e.facility.latitude!, lng: e.facility.longitude! }));
  return (
    <APIProvider apiKey={GOOGLE_MAPS_KEY} region="AU" language="en-AU">
      <div className="h-[460px] w-full overflow-hidden rounded-lg border" aria-label="Map of clinics" role="region">
        <Map
          defaultCenter={centre}
          defaultZoom={11}
          mapId={GOOGLE_MAPS_MAP_ID}
          colorScheme="FOLLOW_SYSTEM"
          gestureHandling="cooperative"
          clickableIcons={false}
          mapTypeControl={false}
          streetViewControl={false}
          fullscreenControl
        >
          <FitBounds points={focus} />
          {entries.map((e) => (
            <ClinicPin
              key={e.facility.id}
              entry={e}
              rank={ranks[e.facility.id]}
              faded={ranked.length > 0 && ranks[e.facility.id] === undefined}
              open={openId === e.facility.id}
              onOpen={() => setOpenId(e.facility.id)}
              onClose={() => setOpenId(null)}
            />
          ))}
        </Map>
      </div>
    </APIProvider>
  );
}
