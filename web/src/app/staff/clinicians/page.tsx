"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { PageHeader, QueryView, EmptyState } from "@/components/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RequireClinic } from "@/features/staff/clinic-context";
import { ClinicianProfileForm, LOGIN_LINK_NOTE } from "@/features/staff/clinician-forms";
import { clinicToday } from "@/lib/clinic-day";
import { useApi } from "@/lib/data/context";
import { friendlyError } from "@/lib/errors";
import { CLINICIAN_TYPE_LABEL, clinicianName } from "@/lib/format";
import { validOn } from "@/lib/history";
import { formatIsoDate } from "@/lib/time";
import { useRouter } from "next/navigation";
import type { Facility } from "@/types/db";

function NewClinicianDialog() {
  const api = useApi();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Add clinician</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a clinician</DialogTitle>
          <DialogDescription>Then add their clinic affiliation so they appear at this clinic.</DialogDescription>
        </DialogHeader>
        <ClinicianProfileForm
          submitLabel="Create clinician"
          onSubmit={async (v) => {
            try {
              const c = await api.createClinician(v);
              toast.success("Clinician created");
              setOpen(false);
              router.push(`/staff/clinicians/${c.id}`);
            } catch (err) {
              toast.error(friendlyError(err));
            }
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function Clinicians({ clinic }: { clinic: Facility }) {
  const api = useApi();
  const query = useQuery({
    queryKey: ["clinicians-admin", clinic.id],
    queryFn: async () => {
      const [affs, clinicians] = await Promise.all([api.listAffiliations(), api.listClinicians()]);
      return { affs: affs.filter((a) => a.facility_id === clinic.id), clinicians };
    },
  });
  const today = clinicToday(clinic.timezone);
  return (
    <>
      <PageHeader title="Clinicians" description={clinic.name} actions={<NewClinicianDialog />} />
      <Alert className="mb-4">
        <AlertDescription>{LOGIN_LINK_NOTE}</AlertDescription>
      </Alert>
      <QueryView query={query}>
        {({ affs, clinicians }) => {
          const ids = [...new Set(affs.map((a) => a.clinician_id))];
          const rows = ids
            .map((id) => ({
              clinician: clinicians.find((c) => c.id === id)!,
              aff: affs.filter((a) => a.clinician_id === id).sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0],
            }))
            .filter((r) => r.clinician);
          const unaffiliated = clinicians.filter((c) => !ids.includes(c.id));
          return (
            <div className="grid gap-6">
              {rows.length === 0 ? (
                <EmptyState title="No clinicians at this clinic" />
              ) : (
                <div className="overflow-x-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Role here</TableHead>
                        <TableHead>Affiliation</TableHead>
                        <TableHead>Login linked</TableHead>
                        <TableHead>
                          <span className="sr-only">Actions</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map(({ clinician: c, aff }) => (
                        <TableRow key={c.id}>
                          <TableCell className="font-medium">
                            {clinicianName(c)}
                            {!c.is_active ? <span className="text-muted-foreground"> (inactive)</span> : null}
                          </TableCell>
                          <TableCell>
                            {CLINICIAN_TYPE_LABEL[c.clinician_type]}
                            {c.specialty ? ` · ${c.specialty}` : ""}
                          </TableCell>
                          <TableCell>{aff.role ?? "—"}</TableCell>
                          <TableCell>
                            {validOn(aff, today) ? "Current" : aff.valid_from > today ? "Starts" : "Ended"} · {formatIsoDate(aff.valid_from)}
                            {aff.valid_to ? ` to ${formatIsoDate(aff.valid_to)}` : ""}
                          </TableCell>
                          <TableCell>{c.auth_user_id ? "Yes" : "No"}</TableCell>
                          <TableCell>
                            <Button asChild size="sm" variant="outline">
                              <Link href={`/staff/clinicians/${c.id}`}>Manage</Link>
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              {unaffiliated.length ? (
                <Card>
                  <CardHeader>
                    <CardTitle>
                      <h2 className="text-base">Clinicians not at this clinic</h2>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="flex flex-wrap gap-2">
                      {unaffiliated.map((c) => (
                        <li key={c.id}>
                          <Button asChild size="sm" variant="outline">
                            <Link href={`/staff/clinicians/${c.id}`}>{clinicianName(c)}</Link>
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              ) : null}
            </div>
          );
        }}
      </QueryView>
    </>
  );
}

export default function CliniciansPage() {
  return <RequireClinic>{(clinic) => <Clinicians clinic={clinic} />}</RequireClinic>;
}
