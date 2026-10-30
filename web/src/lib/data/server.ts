import "server-only";
// DataApi for server components and route handlers, as the signed-in user.
import { cookies } from "next/headers";
import { IS_MOCK } from "@/lib/env";
import { decodeMockSession, MOCK_SESSION_COOKIE } from "@/lib/mock/session";
import { getMockState } from "@/lib/mock/server-state";
import { createMockApi } from "@/lib/mock/store";
import { getServerSupabase } from "@/lib/supabase/server";
import type { DataApi } from "./api";
import { createLiveApi } from "./live";

export async function getServerApi(): Promise<DataApi> {
  if (IS_MOCK) {
    const session = decodeMockSession((await cookies()).get(MOCK_SESSION_COOKIE)?.value);
    return createMockApi(getMockState(), session?.uid ?? null);
  }
  return createLiveApi(await getServerSupabase());
}
