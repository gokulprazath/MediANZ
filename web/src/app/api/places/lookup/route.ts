// Suburb or postcode -> map centre for the Find care location picker, when the
// place isn't in the local table (config/postcodes.ts). Google Places Text
// Search with the server-only GOOGLE_PLACES_API_KEY, for signed-in users only so
// the key is never an open geocoder; Australia only. The query is a place name,
// not health data, and is neither stored nor logged.
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { IS_MOCK } from "@/lib/env";
import { decodeMockSession, MOCK_SESSION_COOKIE } from "@/lib/mock/session";
import { getServerSupabase } from "@/lib/supabase/server";

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const QUERY = /^[\p{L}\d][\p{L}\d '.-]{1,59}$/u;
const PLACE_TYPES = new Set(["postal_code", "locality", "sublocality", "neighborhood", "colloquial_area"]);
// Mainland Australia and Tasmania: a result outside it is not the place the patient meant.
const inAustralia = (lat: number, lng: number) => lat >= -44 && lat <= -10 && lng >= 112 && lng <= 154;

const json = (body: unknown, status: number, cache = "no-store") =>
  NextResponse.json(body, { status, headers: { "Cache-Control": cache } });

interface PlacesResult {
  places?: { formattedAddress?: string; types?: string[]; location?: { latitude?: number; longitude?: number } }[];
}

async function signedIn(): Promise<boolean> {
  if (IS_MOCK) return !!decodeMockSession((await cookies()).get(MOCK_SESSION_COOKIE)?.value);
  const { data } = await (await getServerSupabase()).auth.getUser();
  return !!data.user;
}

export async function GET(request: Request) {
  const query = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (!QUERY.test(query)) return json({ error: "invalid_query" }, 400);
  if (!(await signedIn())) return json({ error: "unauthorized" }, 401);
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return json({ error: "not_configured" }, 503);

  const res = await fetch(SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "places.formattedAddress,places.types,places.location",
    },
    body: JSON.stringify({ textQuery: `${query}, Australia`, regionCode: "AU", languageCode: "en" }),
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);
  if (!res?.ok) return json({ error: "unavailable" }, 502);

  const place = ((await res.json().catch(() => ({}))) as PlacesResult).places?.[0];
  const lat = place?.location?.latitude;
  const lng = place?.location?.longitude;
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !inAustralia(lat, lng) ||
    !(place?.types ?? []).some((t) => PLACE_TYPES.has(t))
  ) {
    return json({ error: "not_found" }, 404);
  }
  return json({ lat, lng, label: place?.formattedAddress ?? query }, 200, "private, max-age=86400");
}
