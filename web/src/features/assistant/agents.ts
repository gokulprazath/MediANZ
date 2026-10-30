// How each agent of the fleet is shown to the patient. The agent service's
// router picks the agent from the message; the model never picks its own.
import type { AgentRole } from "@/lib/agents/types";

export const AGENT_LABEL: Record<AgentRole, { name: string; does: string }> = {
  insights: { name: "Records agent", does: "Answers from your approved record only" },
  insurance: { name: "Insurance agent", does: "Reads your plan and public cover information" },
  explainer: { name: "Fees and matching agent", does: "Explains clinic scores and fees" },
  extractor: { name: "Documentation agent", does: "Drafts notes for your clinician to approve" },
  "insights-writer": { name: "Question writer", does: "Sends a question you approved" },
  booking: { name: "Booking agent", does: "Finds a free time; books only when you confirm" },
};

export const SUGGESTIONS = [
  "What medication did my GP start?",
  "What follow-up did my doctor arrange?",
  "Does my insurance cover a GP visit?",
  "Why are fees different between clinics?",
  "Book me the next available GP appointment",
];
