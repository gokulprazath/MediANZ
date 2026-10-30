import { SignOutButton } from "@/components/portal-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Account not set up" };

export default function NotSetUpPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1 className="text-xl">Your account isn&apos;t set up yet</h1>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p>
          You&apos;re signed in, but this login isn&apos;t linked to a patient, clinician or staff profile yet. If you work
          at a clinic, ask the clinic administrator to link your login. If you&apos;re a patient, create a patient account
          with the sign-up page.
        </p>
        <SignOutButton className="justify-self-start" />
      </CardContent>
    </Card>
  );
}
