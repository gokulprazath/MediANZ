// "/" sends each signed-in user to their portal (spec 3: role routing order).
import { redirect } from "next/navigation";
import { getServerApi } from "@/lib/data/server";
import { homePathFor } from "@/lib/roles";

export const dynamic = "force-dynamic";

export default async function Home() {
  const api = await getServerApi();
  const me = await api.whoami().catch(() => null);
  redirect(homePathFor(me));
}
