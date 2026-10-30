// "Add to calendar": builds a .ics from an appointment the signed-in user can
// already read (RLS decides). Nothing is stored.
import { NextResponse } from "next/server";
import { getServerApi } from "@/lib/data/server";
import { buildIcs } from "@/lib/ics";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return new NextResponse(null, { status: 400 });
  const api = await getServerApi();
  const appointment = await api.getAppointment(id).catch(() => null);
  if (!appointment) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(buildIcs(appointment), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="medianz-appointment.ics"',
      "Cache-Control": "no-store",
    },
  });
}
