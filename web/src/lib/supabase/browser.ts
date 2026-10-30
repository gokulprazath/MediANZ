"use client";
// Browser Supabase client: anon / publishable key + the user's cookie session.
import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertLiveConfig, SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/env";

let client: SupabaseClient | null = null;

export function getBrowserSupabase(): SupabaseClient {
  assertLiveConfig();
  client ??= createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return client;
}
