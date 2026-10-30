"use client";
import { useQuery } from "@tanstack/react-query";
import { QueryView } from "@/components/states";
import { useApi } from "@/lib/data/context";
import { APPOINTMENT_STATUS_LABEL } from "@/lib/format";
import { formatDateTime } from "@/lib/time";

export function StatusHistory({ appointmentId, timeZone }: { appointmentId: string; timeZone: string }) {
  const api = useApi();
  const query = useQuery({ queryKey: ["status-history", appointmentId], queryFn: () => api.listStatusHistory(appointmentId) });
  return (
    <QueryView query={query}>
      {(rows) => (
        <ol className="grid gap-1 border-l-2 pl-4 text-sm">
          {rows.map((h) => (
            <li key={h.id}>
              <span className="font-medium">{APPOINTMENT_STATUS_LABEL[h.to_status]}</span>
              <span className="text-muted-foreground"> · {formatDateTime(h.changed_at, timeZone)}</span>
            </li>
          ))}
        </ol>
      )}
    </QueryView>
  );
}
