"use client";
// Realtime on appointment_slots for one clinician: slots taken by someone else
// disappear from the grid at once, and the caller hears if its own hold is lost.
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { SlotChange } from "@/lib/data/api";
import { useSubscribeSlots } from "@/lib/data/context";
import type { AvailableSlot } from "@/types/db";

export function isOpenFor(slot: SlotChange["slot"], patientId: string | null, now = Date.now()): boolean {
  if (slot.status === "available") return true;
  if (slot.status === "held") {
    return slot.held_by_patient_id === patientId || !slot.held_until || Date.parse(slot.held_until) < now;
  }
  return false;
}

export function useSlotRealtime(
  clinicianId: string,
  patientId: string | null,
  heldSlotId: string | null,
  onHoldLost: () => void,
) {
  const qc = useQueryClient();
  const subscribe = useSubscribeSlots();
  const held = useRef(heldSlotId);
  const lost = useRef(onHoldLost);
  useEffect(() => {
    held.current = heldSlotId;
    lost.current = onHoldLost;
  });

  useEffect(() => {
    return subscribe(clinicianId, ({ slot }) => {
      if (held.current === slot.id && !(slot.status === "held" && slot.held_by_patient_id === patientId)) {
        lost.current();
      }
      if (isOpenFor(slot, patientId)) {
        // A time opened up (cancellation, leave removed): fetch the day again.
        void qc.invalidateQueries({ queryKey: ["slots", clinicianId] });
      } else {
        qc.setQueriesData<AvailableSlot[]>({ queryKey: ["slots", clinicianId] }, (rows) =>
          rows?.filter((r) => r.slot_id !== slot.id),
        );
      }
    });
  }, [clinicianId, patientId, qc, subscribe]);
}
