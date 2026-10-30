// Reads the signed GP-question draft from the agent service (agent.py
// _sign_action: base64url(JSON) + "." + HMAC). Display only: the page shows the
// exact question and its expiry; the service verifies the signature on confirm.
export interface PendingActionPreview {
  question: string;
  appointmentId: string | null;
  expiresAt: Date | null;
}

export function readPendingAction(token: string): PendingActionPreview | null {
  const body = token.split(".", 1)[0];
  if (!body) return null;
  try {
    const b64 = body.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(body.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (typeof payload.question !== "string") return null;
    return {
      question: payload.question,
      appointmentId: typeof payload.appointment_id === "string" ? payload.appointment_id : null,
      expiresAt: typeof payload.exp === "number" ? new Date(payload.exp * 1000) : null,
    };
  } catch {
    return null;
  }
}
