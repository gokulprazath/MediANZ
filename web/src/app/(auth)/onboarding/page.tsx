"use client";
// Patient onboarding (step 1 of the profile): inserts the patients row with
// auth_user_id = auth.uid(), which the "insert: self or staff" policy allows.
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";
import { SignOutButton } from "@/components/portal-shell";
import { LoadingState } from "@/components/states";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useApi } from "@/lib/data/context";
import { friendlyError } from "@/lib/errors";
import { ME_KEY, useMe } from "@/lib/hooks/use-me";
import { homePathFor } from "@/lib/roles";
import { PersonalForm } from "@/features/profile/personal-form";

export default function OnboardingPage() {
  const api = useApi();
  const qc = useQueryClient();
  const router = useRouter();
  const me = useMe();

  useEffect(() => {
    if (me.isSuccess && homePathFor(me.data) !== "/onboarding") router.replace(homePathFor(me.data));
  }, [me.isSuccess, me.data, router]);

  if (me.isPending || !me.data || homePathFor(me.data) !== "/onboarding") return <LoadingState />;
  const userId = me.data.userId;

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1 className="text-xl">Welcome to MediANZ</h1>
        </CardTitle>
        <CardDescription>Step 1 of your profile: tell us who you are. You can add Medicare, address and insurance next.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <PersonalForm
          defaults={{ email: me.data.email ?? "" }}
          submitLabel="Continue"
          onSubmit={async (values) => {
            try {
              await api.createPatient({ ...values, auth_user_id: userId });
              await qc.invalidateQueries({ queryKey: ME_KEY });
              toast.success("Profile created");
              router.replace("/patient/profile?welcome=1");
            } catch (err) {
              toast.error(friendlyError(err));
            }
          }}
        />
        <SignOutButton className="justify-self-start" />
      </CardContent>
    </Card>
  );
}
