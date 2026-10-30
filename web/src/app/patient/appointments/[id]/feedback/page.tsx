"use client";
// Feedback (4.7): rate a completed visit; editable for 30 days. Comments go to
// the clinic only and are never shown publicly in Part A (star averages only).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Field } from "@/components/form-field";
import { StarInput } from "@/components/star-rating";
import { EmptyState, PageHeader, QueryView } from "@/components/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useApi } from "@/lib/data/context";
import { friendlyError } from "@/lib/errors";
import { clinicianName } from "@/lib/format";
import { formatDate, formatDateTime } from "@/lib/time";
import { ratingSchema } from "@/lib/validation";
import type { AppointmentWithRefs, ClinicianRating } from "@/types/db";

const EDIT_DAYS = 30;

function RatingForm({ appointment, existing }: { appointment: AppointmentWithRefs; existing: ClinicianRating | null }) {
  const api = useApi();
  const qc = useQueryClient();
  const form = useForm({
    resolver: zodResolver(ratingSchema),
    defaultValues: {
      rating: (existing?.rating ?? null) as number,
      rating_communication: existing?.rating_communication ?? null,
      rating_wait_time: existing?.rating_wait_time ?? null,
      would_recommend: existing?.would_recommend ?? null,
      comment: existing?.comment ?? "",
      is_anonymous: existing?.is_anonymous ?? false,
    },
  });
  const { errors, isSubmitting } = form.formState;
  const comment = form.watch("comment") ?? "";

  return (
    <form
      noValidate
      className="grid gap-5"
      onSubmit={form.handleSubmit(async (v) => {
        try {
          if (existing) await api.updateRating(existing.id, v);
          else await api.createRating(appointment.id, v);
          await qc.invalidateQueries({ queryKey: ["rating", appointment.id] });
          toast.success(existing ? "Your feedback is updated" : "Thanks for your feedback");
        } catch (err) {
          toast.error(friendlyError(err));
        }
      })}
    >
      <Controller
        control={form.control}
        name="rating"
        render={({ field }) => (
          <StarInput label="Overall" value={field.value ?? null} onChange={field.onChange} required error={errors.rating?.message} />
        )}
      />
      <Controller
        control={form.control}
        name="rating_communication"
        render={({ field }) => <StarInput label="Communication (optional)" value={field.value} onChange={field.onChange} />}
      />
      <Controller
        control={form.control}
        name="rating_wait_time"
        render={({ field }) => <StarInput label="Wait time (optional)" value={field.value} onChange={field.onChange} />}
      />
      <Controller
        control={form.control}
        name="would_recommend"
        render={({ field }) => (
          <fieldset className="grid gap-1.5">
            <legend className="text-sm font-medium">Would you recommend {clinicianName(appointment.clinician)}? (optional)</legend>
            <div className="flex flex-wrap gap-4">
              {[
                { v: true, label: "Yes" },
                { v: false, label: "No" },
                { v: null, label: "Prefer not to say" },
              ].map((o) => (
                <label key={String(o.v)} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="would_recommend"
                    checked={field.value === o.v}
                    onChange={() => field.onChange(o.v)}
                    className="size-4 accent-primary"
                  />
                  {o.label}
                </label>
              ))}
            </div>
          </fieldset>
        )}
      />
      <Field
        label="Comment (optional)"
        error={errors.comment?.message}
        hint={`Your comment goes to the clinic. Please don't include medical details. ${comment.length}/2000`}
      >
        <Textarea rows={4} maxLength={2000} {...form.register("comment")} />
      </Field>
      <Controller
        control={form.control}
        name="is_anonymous"
        render={({ field }) => (
          <div className="flex items-start gap-2">
            <Checkbox id="anonymous" checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} />
            <div className="grid gap-1">
              <Label htmlFor="anonymous">Don&apos;t show my name to the clinician</Label>
              <p className="text-sm text-muted-foreground">Clinic staff can still see who left the feedback.</p>
            </div>
          </div>
        )}
      />
      <div>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : existing ? "Update feedback" : "Send feedback"}
        </Button>
      </div>
    </form>
  );
}

export default function FeedbackPage() {
  const api = useApi();
  const { id } = useParams<{ id: string }>();
  const [openedAt] = useState(() => Date.now());
  const query = useQuery({
    queryKey: ["rating", id],
    queryFn: async () => {
      const [appointment, canRate, rating] = await Promise.all([
        api.getAppointment(id),
        api.canRateAppointment(id),
        api.getRatingForAppointment(id),
      ]);
      return { appointment, canRate, rating };
    },
  });

  return (
    <QueryView query={query}>
      {({ appointment: a, canRate, rating }) => {
        if (!a) return <EmptyState title="Appointment not found" />;
        const tz = a.facility.timezone;
        const editableUntil = rating ? Date.parse(rating.created_at) + EDIT_DAYS * 86_400_000 : null;
        const editable = rating ? editableUntil! > openedAt : canRate;
        return (
          <div className="mx-auto grid max-w-2xl gap-6">
            <PageHeader
              title="Rate your visit"
              description={`${formatDate(a.scheduled_start, tz)} with ${clinicianName(a.clinician)} at ${a.facility.name}`}
            />
            {editable ? (
              <Card>
                <CardContent className="pt-6">
                  {rating && editableUntil ? (
                    <p className="mb-4 text-sm text-muted-foreground">
                      You can change your feedback until {formatDateTime(new Date(editableUntil), tz)}.
                    </p>
                  ) : null}
                  <RatingForm appointment={a} existing={rating} />
                </CardContent>
              </Card>
            ) : (
              <Alert>
                <AlertDescription>
                  {rating
                    ? "Thanks for your feedback. The 30 days for changing it have passed."
                    : a.status === "completed"
                      ? "Feedback can be left for 30 days after a visit."
                      : "You can rate a visit once it is completed."}
                </AlertDescription>
              </Alert>
            )}
            <p className="text-sm text-muted-foreground">
              Other patients only see star averages, never comments.{" "}
              <Link className="underline" href="/privacy">
                Privacy
              </Link>
            </p>
          </div>
        );
      }}
    </QueryView>
  );
}
