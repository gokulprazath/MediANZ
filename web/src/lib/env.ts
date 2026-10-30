// Public configuration. NEXT_PUBLIC_* values are inlined at build time, so each
// one is referenced literally. Only the anon / publishable key is ever used in
// the browser; the service role key never appears in frontend code.
export type DataMode = "mock" | "live";

export const DATA_MODE: DataMode = process.env.NEXT_PUBLIC_DATA_MODE === "live" ? "live" : "mock";
export const IS_MOCK = DATA_MODE === "mock";

export const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
export const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

export const TRANSCRIBE_FUNCTION_URL = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/transcribe-consult` : "";

export const GOOGLE_MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ?? "";
// Advanced markers need a map id; Google's DEMO_MAP_ID works for development.
export const GOOGLE_MAPS_MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID || "DEMO_MAP_ID";

export const SHOW_DEV_BANNER = process.env.NODE_ENV !== "production" || IS_MOCK;

export function assertLiveConfig(): void {
  if (DATA_MODE === "live" && (!SUPABASE_URL || !SUPABASE_ANON_KEY)) {
    throw new Error(
      "NEXT_PUBLIC_DATA_MODE=live needs NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (or _PUBLISHABLE_KEY).",
    );
  }
}
