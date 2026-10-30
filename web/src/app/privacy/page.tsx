// Public privacy page. The recording section uses the same consent wording
// (config/consent.ts, version v1) that patients and clinicians agree to.
import { HeartPulse } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { CONSENT_POINTS, CONSENT_TITLE, CONSENT_VERSION } from "@/config/consent";

export const metadata: Metadata = { title: "Privacy and recording consent · MediANZ" };

export default function PrivacyPage() {
  return (
    <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">
      <Link href="/" className="mb-8 flex items-center gap-2 text-lg font-semibold">
        <HeartPulse className="size-6 text-primary" aria-hidden="true" />
        MediANZ
      </Link>
      <h1 className="text-3xl font-semibold tracking-tight">Privacy and recording consent</h1>

      <section aria-labelledby="data" className="mt-8 grid gap-3">
        <h2 id="data" className="text-xl font-semibold">
          Your health information
        </h2>
        <p>
          MediANZ keeps your profile, appointments and visit records so your clinic can care for you. Your health
          information is never used for advertising or analytics, never put in web addresses, and never sent to error
          tracking services.
        </p>
        <p>
          Your location is used only in your browser to find nearby clinics. It is not stored. What you type in
          &ldquo;What do you need help with?&rdquo; is kept in the page until you book, and then saved as the reason for
          your appointment.
        </p>
        <p>
          Ratings: other patients see only star averages, never comments. Your comment goes to the clinic. You can choose
          not to show your name to the clinician.
        </p>
      </section>

      <section aria-labelledby="recording" className="mt-8 grid gap-3">
        <h2 id="recording" className="text-xl font-semibold">
          {CONSENT_TITLE}
        </h2>
        <p>
          Recording a consultation is optional. Your care is the same whether or not you agree. This is the wording you
          see before agreeing (version {CONSENT_VERSION}):
        </p>
        <dl className="grid gap-4 rounded-lg border p-4">
          {CONSENT_POINTS.map((p) => (
            <div key={p.heading}>
              <dt className="font-medium">{p.heading}</dt>
              <dd className="text-muted-foreground">{p.text}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="advice" className="mt-8 grid gap-3">
        <h2 id="advice" className="text-xl font-semibold">
          No medical advice online
        </h2>
        <p>
          MediANZ helps you find and book care. It does not give diagnoses or medical advice. In an emergency call{" "}
          <a className="underline" href="tel:000">
            000
          </a>
          . For crisis support call Lifeline on{" "}
          <a className="underline" href="tel:131114">
            13 11 14
          </a>
          .
        </p>
      </section>
    </main>
  );
}
