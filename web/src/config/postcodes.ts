// Approximate centre points for the sample data's suburbs and postcodes, used
// when the browser's location is not available. The location is only used in
// memory for distances and is never stored or sent anywhere.
export interface PlaceCentre {
  postcode: string;
  suburb: string;
  state: string;
  lat: number;
  lng: number;
}

export const PLACES: PlaceCentre[] = [
  { postcode: "4000", suburb: "Brisbane City", state: "QLD", lat: -27.4698, lng: 153.0251 },
  { postcode: "4101", suburb: "South Brisbane", state: "QLD", lat: -27.4806, lng: 153.0186 },
  { postcode: "4101", suburb: "West End", state: "QLD", lat: -27.4818, lng: 153.0088 },
  { postcode: "4064", suburb: "Paddington", state: "QLD", lat: -27.4598, lng: 152.9996 },
  { postcode: "4064", suburb: "Milton", state: "QLD", lat: -27.4703, lng: 153.0034 },
  { postcode: "4051", suburb: "Wilston", state: "QLD", lat: -27.4337, lng: 153.0194 },
  { postcode: "4032", suburb: "Chermside", state: "QLD", lat: -27.3856, lng: 153.0312 },
  { postcode: "2150", suburb: "Parramatta", state: "NSW", lat: -33.8148, lng: 151.0017 },
  { postcode: "2000", suburb: "Sydney", state: "NSW", lat: -33.8688, lng: 151.2093 },
];

export function findPlace(query: string): PlaceCentre | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  return PLACES.find((p) => p.postcode === q) ?? PLACES.find((p) => p.suburb.toLowerCase() === q) ?? null;
}
