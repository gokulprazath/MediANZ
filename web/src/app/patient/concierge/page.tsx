// The AI care finder now lives on Find care (/patient/find), with the map.
import { redirect } from "next/navigation";

export default function ConciergePage() {
  redirect("/patient/find");
}
