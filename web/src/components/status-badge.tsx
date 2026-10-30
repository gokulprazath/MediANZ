import { APPOINTMENT_STATUS_LABEL, SLOT_STATUS_LABEL } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AppointmentStatus, SlotStatus } from "@/types/db";

// Status is always written out; colour only reinforces it.
const APPT_TONE: Record<AppointmentStatus, string> = {
  booked: "bg-secondary text-secondary-foreground",
  confirmed: "bg-accent text-accent-foreground",
  checked_in: "bg-warning-soft text-warning",
  in_consultation: "bg-warning-soft text-warning",
  completed: "bg-success-soft text-success",
  cancelled: "bg-muted text-muted-foreground line-through decoration-1",
  no_show: "bg-danger-soft text-destructive",
  rescheduled: "bg-muted text-muted-foreground",
};

export const APPT_CALENDAR_COLOUR: Record<AppointmentStatus, string> = {
  booked: "#0e7490",
  confirmed: "#0f766e",
  checked_in: "#a16207",
  in_consultation: "#b45309",
  completed: "#15803d",
  cancelled: "#6b7280",
  no_show: "#b91c1c",
  rescheduled: "#6b7280",
};

export function AppointmentStatusBadge({ status, className }: { status: AppointmentStatus; className?: string }) {
  return (
    <span
      className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap", APPT_TONE[status], className)}
    >
      {APPOINTMENT_STATUS_LABEL[status]}
    </span>
  );
}

const SLOT_TONE: Record<SlotStatus, string> = {
  available: "bg-success-soft text-success",
  held: "bg-warning-soft text-warning",
  booked: "bg-accent text-accent-foreground",
  blocked: "bg-muted text-muted-foreground",
};

export function SlotStatusBadge({ status }: { status: SlotStatus }) {
  return (
    <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium", SLOT_TONE[status])}>
      {SLOT_STATUS_LABEL[status]}
    </span>
  );
}
