import "server-only";
// Where the /api/agents proxy sends each request (server-side, never the browser).
// On Vercel (vercel.json, services mode) the Python backend is one internal
// service reached over a binding: BACKEND_URL is injected at runtime, and the
// backend mounts the agent at /agent and discovery at /discovery. Locally the two
// Python services run separately at AGENT_SERVICE_URL and DISCOVERY_SERVICE_URL.
import type { Upstream } from "./routes";

const MOUNT: Record<Upstream, string> = { agent: "agent", discovery: "discovery" };

export function upstreamBase(upstream: Upstream, env: Record<string, string | undefined> = process.env): string {
  const backend = env.BACKEND_URL;
  if (backend) return new URL(MOUNT[upstream], backend.endsWith("/") ? backend : `${backend}/`).toString();
  const url = upstream === "agent" ? env.AGENT_SERVICE_URL : env.DISCOVERY_SERVICE_URL;
  return (url ?? "").replace(/\/+$/, "");
}
