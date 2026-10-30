"use client";
// Staff can insert patients rows ("insert: self or staff"). The login is not
// linked here; a patient who later signs up is linked by the clinic manually.
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PersonalForm } from "@/features/profile/personal-form";
import { useApi } from "@/lib/data/context";
import { friendlyError } from "@/lib/errors";
import { personName } from "@/lib/format";
import type { Patient } from "@/types/db";

export default function NewPatientPage() {
  const api = useApi();
  const [created, setCreated] = useState<Patient | null>(null);
  const [formKey, setFormKey] = useState(0);
  return (
    <>
      <PageHeader title="Register a new patient" description="Medicare, address and insurance can be added by the patient later." />
      {created ? (
        <Alert className="mb-4" role="status">
          <AlertTitle>{personName(created)} is registered</AlertTitle>
          <AlertDescription className="flex flex-wrap gap-2 pt-2">
            <Button asChild size="sm">
              <Link href={`/staff/book?patient=${created.id}`}>Book an appointment</Link>
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setCreated(null);
                setFormKey((k) => k + 1);
              }}
            >
              Register another
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardContent className="pt-6">
          <PersonalForm
            key={formKey}
            submitLabel="Register patient"
            onSubmit={async (values) => {
              try {
                const p = await api.createPatient(values);
                setCreated(p);
                toast.success("Patient registered");
              } catch (err) {
                toast.error(friendlyError(err));
              }
            }}
          />
        </CardContent>
      </Card>
    </>
  );
}
