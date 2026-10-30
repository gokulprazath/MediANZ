"use client";
import { LocateFixed } from "lucide-react";
import { useState } from "react";
import { Field } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { findPlace, PLACES } from "@/config/postcodes";
import { useFindCare } from "./context";

export function RadiusInput() {
  const { radiusKm, setRadiusKm } = useFindCare();
  const [text, setText] = useState(String(radiusKm));
  const n = Number(text);
  const error = text === "" || !Number.isInteger(n) || n < 1 || n > 100 ? "Enter a whole number from 1 to 100" : undefined;
  return (
    <Field label="Distance (km)" error={error} hint="1 to 100 km." className="w-40">
      <Input
        type="number"
        inputMode="numeric"
        min={1}
        max={100}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          if (Number.isInteger(v) && v >= 1 && v <= 100) setRadiusKm(v);
        }}
      />
    </Field>
  );
}

// Browser location if allowed; otherwise a suburb or postcode from the local table.
export function LocationPicker() {
  const { location, setLocation } = useFindCare();
  const [status, setStatus] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | undefined>();

  const useDevice = () => {
    if (!("geolocation" in navigator)) {
      setStatus("Your browser can't share its location. Enter a suburb or postcode instead.");
      return;
    }
    setStatus("Finding your location…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude, label: "your location", source: "device" });
        setStatus(null);
      },
      () => setStatus("Location wasn't shared. Enter a suburb or postcode instead."),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    );
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Button type="button" variant="outline" onClick={useDevice}>
          <LocateFixed aria-hidden="true" />
          Use my location
        </Button>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const place = findPlace(query);
            if (!place) {
              setError("We don't know that suburb or postcode yet. Try one from the list.");
              return;
            }
            setError(undefined);
            setLocation({ lat: place.lat, lng: place.lng, label: `${place.suburb} ${place.postcode}`, source: "postcode" });
          }}
        >
          <Field label="Or suburb / postcode" error={error} className="w-56">
            <Input list="known-places" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="postal-code" />
          </Field>
          <datalist id="known-places">
            {PLACES.map((p) => (
              <option key={`${p.suburb}-${p.postcode}`} value={p.postcode}>
                {p.suburb}
              </option>
            ))}
          </datalist>
          <Button type="submit" variant="secondary">
            Set
          </Button>
        </form>
      </div>
      <p className="text-sm" role="status" aria-live="polite">
        {status ?? (location ? `Showing distances from ${location.label}.` : "No location set: all clinics are shown.")}
      </p>
    </div>
  );
}
