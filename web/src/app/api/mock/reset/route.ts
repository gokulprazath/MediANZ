// Mock mode only: rebuild the mock database from the seed (used by the e2e tests).
import { NextResponse } from "next/server";
import { IS_MOCK } from "@/lib/env";
import { resetMockState } from "@/lib/mock/server-state";

export async function POST() {
  if (!IS_MOCK) return new NextResponse(null, { status: 404 });
  resetMockState();
  return NextResponse.json({ ok: true });
}
