"use client";
// Google Map of clinics. Each pin has a coloured flag AND a text label (and an
// icon), so colour is never the only cue. Hover or tap opens the clinic card.
import { AdvancedMarker, APIProvider, InfoWindow, Map, useAdvancedMarkerRef } from "@vis.gl/react-google-maps";
import { useState } from "react";
import { GOOGLE_MAPS_KEY, GOOGLE_MAPS_MAP_ID } from "@/lib/env";
import type { LatLng } from "@/lib/geo";
import { AvailabilityIcon, ClinicCard } from "./clinic-card";
import { AVAILABILITY_LEGEND, type ClinicEntry } from "./directory";

function ClinicPin({ entry, open, onOpen, onClose }: { entry: ClinicEntry; open: boolean; onOpen: () => void; onClose: () => void }) {
  const [ref, marker] = useAdvancedMarkerRef();
  const legend = AVAILABILITY_LEGEND[entry.availability];
  return (
    <>
      <AdvancedMarker
        ref={ref}
        position={{ lat: entry.facility.latitude!, lng: entry.facility.longitude! }}
        title={`${entry.facility.name}: ${legend.label}`}
        onClick={onOpen}
        onMouseEnter={onOpen}
      >
        <div
          className="flex items-center gap-1 rounded-full border-2 bg-white px-2 py-1 text-xs font-semibold text-gray-900 shadow"
          style={{ borderColor: legend.border }}
        >
          <span aria-hidden="true" className="inline-block size-3 rounded-full" style={{ background: legend.colour }} />
          <AvailabilityIcon availability={entry.availability} />
          <span>
            {entry.facility.name.split(" ")[0]} · {legend.short}
          </span>
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

export function ClinicMap({ entries, centre }: { entries: ClinicEntry[]; centre: LatLng }) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (!GOOGLE_MAPS_KEY) return null;
  return (
    <APIProvider apiKey={GOOGLE_MAPS_KEY} region="AU" language="en-AU">
      <div className="h-[420px] w-full overflow-hidden rounded-lg border" aria-label="Map of clinics" role="region">
        <Map defaultCenter={centre} defaultZoom={11} mapId={GOOGLE_MAPS_MAP_ID} gestureHandling="cooperative" disableDefaultUI={false}>
          {entries.map((e) => (
            <ClinicPin
              key={e.facility.id}
              entry={e}
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
