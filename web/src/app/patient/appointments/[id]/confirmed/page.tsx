"use client";
import { useQuery } from "@tanstack/react-query";
import { CalendarPlus, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { EmptyState, QueryView } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useApi } from "@/lib/data/context";
import { clinicianName, visitTypeLabel } from "@/lib/format";
import { formatDateTime } from "@/lib/time";

export default function BookingConfirmedPage() {
  const api = useApi();
  const { id } = useParams<{ id: string }>();
  const query = useQuery({ queryKey: ["appointment", id], queryFn: () => api.getAppointment(id) });
  return (
    <QueryView query={query}>
      {(a) =>
        !a ? (
          <EmptyState title="Appointment not found" />
        ) : (
          <Card className="mx-auto max-w-xl">
            <CardHeader>
              <CardTitle>
                <div role="status">
                  <h1 className="flex items-center gap-2 text-xl">
                    <CheckCircle2 className="size-6 text-success" aria-hidden="true" />
                    You&apos;re booked in
                  </h1>
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                <dt className="text-muted-foreground">When</dt>
                <dd className="font-medium">{formatDateTime(a.scheduled_start, a.facility.timezone)}</dd>
                <dt className="text-muted-foreground">With</dt>
                <dd>{clinicianName(a.clinician)}</dd>
                <dt className="text-muted-foreground">Where</dt>
                <dd>
                  {a.facility.name}, {a.facility.address_line1}, {a.facility.suburb}
                </dd>
                <dt className="text-muted-foreground">Visit</dt>
                <dd>{visitTypeLabel(a.visit_type)}</dd>
              </dl>
              <p className="text-sm text-muted-foreground">On the day, please check in at reception when you arrive.</p>
              <div className="flex flex-wrap gap-2">
                <Button asChild>
                  <a href={`/api/appointments/${a.id}/ics`} download>
                    <CalendarPlus aria-hidden="true" />
                    Add to calendar
                  </a>
                </Button>
                <Button asChild variant="outline">
                  <Link href="/patient/appointments">My appointments</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        )
      }
    </QueryView>
  );
}
