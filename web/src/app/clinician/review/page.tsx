"use client";
import { PageHeader, QueryView } from "@/components/states";
import { ReviewQueue, reviewCount, useReviewData } from "@/features/review/review-queue";
import { useMe } from "@/lib/hooks/use-me";

export default function ReviewQueuePage() {
  const me = useMe();
  const query = useReviewData(me.data?.clinician?.id ?? "");
  return (
    <>
      <PageHeader
        title="Review queue"
        description={
          query.data
            ? `${reviewCount(query.data)} item${reviewCount(query.data) === 1 ? "" : "s"} drafted by the AI agents, waiting for you. Urgent items and patient questions come first.`
            : "Drafts from the AI agents, waiting for you."
        }
      />
      <QueryView query={query}>{(data) => <ReviewQueue data={data} />}</QueryView>
    </>
  );
}
