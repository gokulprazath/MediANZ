import { IS_MOCK } from "@/lib/env";

export function DevBanner() {
  if (!IS_MOCK) return null;
  return (
    <div className="bg-warning-soft px-4 py-1.5 text-center text-sm text-warning">
      <strong>Mock mode:</strong> sample data from supabase/seed, held in memory. Nothing is sent to Supabase.
    </div>
  );
}
