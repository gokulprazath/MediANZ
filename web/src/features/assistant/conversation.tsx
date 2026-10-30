"use client";
// The AI assistant conversation, held above the patient pages: it survives
// moving between pages and ends when the patient signs out (the patient portal
// unmounts) or another patient signs in. Kept in memory only, never in browser
// storage, because it may contain health information. A reply that arrives
// after the patient has left the assistant page still lands here.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { agentErrorMessage, agents } from "@/lib/agents/client";
import type { AgentRole, BookingProposalCard, ChatTurn } from "@/lib/agents/types";
import { useMe } from "@/lib/hooks/use-me";

export type BookingOutcome = { status: "booked"; appointmentId: string } | { status: "declined" };

export type Turn =
  | { id: number; from: "patient"; text: string }
  | {
      id: number;
      from: "agent";
      agent: AgentRole;
      text: string;
      pending: { action: string; appointmentId: string | null } | null;
      decided?: "sent" | "declined";
      proposal: BookingProposalCard | null;
      booking?: BookingOutcome;
    }
  | { id: number; from: "error"; text: string };

type AgentTurn = Extract<Turn, { from: "agent" }>;

// Earlier turns sent with each message (agent.py ChatRequest.history accepts up to
// 12 of 4000 characters; 2000 keeps 12 turns plus the message under the proxy's
// 32 KB body limit).
const HISTORY_TURNS = 12;
const HISTORY_CHARS = 2000;

export function historyFor(turns: Turn[]): ChatTurn[] {
  return turns
    .filter((t): t is Exclude<Turn, { from: "error" }> => t.from !== "error")
    .slice(-HISTORY_TURNS)
    .map((t) => ({ role: t.from === "patient" ? "patient" : "assistant", text: t.text.slice(0, HISTORY_CHARS) }));
}

interface ConversationState {
  turns: Turn[];
  busy: boolean;
  ask: (text: string) => Promise<void>;
  update: (id: number, patch: Partial<AgentTurn>) => void;
  clear: () => void;
}

const ConversationContext = createContext<ConversationState | null>(null);

export function ConversationProvider({ children }: { children: ReactNode }) {
  const me = useMe();
  const patientId = me.data?.patient?.id ?? null;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const nextId = useRef(1);
  const turnsRef = useRef<Turn[]>([]);
  turnsRef.current = turns;

  // Another patient signing in on this device starts afresh.
  const owner = useRef<string | null>(null);
  useEffect(() => {
    if (patientId && owner.current && owner.current !== patientId) setTurns([]);
    if (patientId) owner.current = patientId;
  }, [patientId]);

  const ask = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || busy) return;
      const history = historyFor(turnsRef.current);
      setTurns((t) => [...t, { id: nextId.current++, from: "patient", text: message }]);
      setBusy(true);
      try {
        const res = await agents.chat({ message, history });
        setTurns((t) => [
          ...t,
          {
            id: nextId.current++,
            from: "agent",
            agent: res.agent,
            text: res.answer,
            pending: res.pending_action ? { action: res.pending_action, appointmentId: res.appointment_id } : null,
            proposal: res.booking_proposal ?? null,
          },
        ]);
      } catch (err) {
        setTurns((t) => [...t, { id: nextId.current++, from: "error", text: agentErrorMessage(err) }]);
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const update = useCallback((id: number, patch: Partial<AgentTurn>) => {
    setTurns((t) => t.map((x) => (x.id === id && x.from === "agent" ? { ...x, ...patch } : x)));
  }, []);
  const clear = useCallback(() => setTurns([]), []);

  const value = useMemo(() => ({ turns, busy, ask, update, clear }), [turns, busy, ask, update, clear]);
  return <ConversationContext value={value}>{children}</ConversationContext>;
}

export function useConversation(): ConversationState {
  const v = useContext(ConversationContext);
  if (!v) throw new Error("useConversation must be used inside ConversationProvider");
  return v;
}
