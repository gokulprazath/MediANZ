"use client";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { addDays, formatIsoDate, formatShortIsoDate } from "@/lib/time";
import { cn } from "@/lib/utils";

export const BOOKING_WEEKS = 8;

/** The next 8 weeks of dates, a week at a time. */
export function DateStrip({
  firstDate,
  selected,
  onSelect,
  week,
  onWeekChange,
}: {
  firstDate: string;
  selected: string;
  onSelect: (date: string) => void;
  week: number;
  onWeekChange: (w: number) => void;
}) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(firstDate, week * 7 + i));
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="icon"
        aria-label="Previous week"
        disabled={week === 0}
        onClick={() => onWeekChange(week - 1)}
      >
        <ChevronLeft aria-hidden="true" />
      </Button>
      <ul className="grid flex-1 grid-cols-7 gap-1" aria-label={`Week of ${formatIsoDate(days[0])}`}>
        {days.map((d) => {
          const f = formatShortIsoDate(d);
          const active = d === selected;
          return (
            <li key={d}>
              <button
                type="button"
                onClick={() => onSelect(d)}
                aria-pressed={active}
                aria-label={formatIsoDate(d)}
                className={cn(
                  "flex w-full flex-col items-center rounded-md border px-1 py-2 text-sm hover:bg-muted",
                  active && "border-primary bg-primary text-primary-foreground hover:bg-primary",
                )}
              >
                <span className="text-xs">{f.weekday}</span>
                <span className="text-lg font-semibold leading-tight">{f.day}</span>
                <span className="text-xs">{f.month}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <Button
        variant="outline"
        size="icon"
        aria-label="Next week"
        disabled={week >= BOOKING_WEEKS - 1}
        onClick={() => onWeekChange(week + 1)}
      >
        <ChevronRight aria-hidden="true" />
      </Button>
    </div>
  );
}
