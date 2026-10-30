import "server-only";
// Server Supabase client for route handlers and server components. It uses the
// signed-in user's cookie session and the anon key, so RLS still applies.
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { assertLiveConfig, SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/env";

export async function getServerSupabase(): Promise<SupabaseClient> {
  assertLiveConfig();
  const store = await cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) store.set(name, value, options);
        } catch {
          // Server components cannot set cookies; proxy.ts refreshes the session.
        }
      },
    },
  });
}
