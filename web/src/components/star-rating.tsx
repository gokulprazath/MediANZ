"use client";
import { Star } from "lucide-react";
import { useId } from "react";
import { cn } from "@/lib/utils";

export function StarDisplay({ value, count, className }: { value: number | null; count?: number; className?: string }) {
  if (value === null || value === undefined) {
    return <span className={cn("text-sm text-muted-foreground", className)}>No ratings yet</span>;
  }
  const rounded = Math.round(Number(value));
  return (
    <span className={cn("inline-flex items-center gap-1 text-sm", className)}>
      <span aria-hidden="true" className="inline-flex">
        {[1, 2, 3, 4, 5].map((i) => (
          <Star key={i} className={cn("size-4", i <= rounded ? "fill-amber-400 text-amber-500" : "text-muted-foreground/40")} />
        ))}
      </span>
      <span>
        {Number(value).toFixed(1)} out of 5{count !== undefined ? ` (${count} rating${count === 1 ? "" : "s"})` : ""}
      </span>
    </span>
  );
}

// Star input as a radio group: arrow keys move, each star has a text label.
export function StarInput({
  label,
  value,
  onChange,
  required,
  error,
}: {
  label: string;
  value: number | null;
  onChange: (v: number) => void;
  required?: boolean;
  error?: string;
}) {
  const name = useId();
  return (
    <fieldset className="grid gap-1.5">
      <legend className="text-sm font-medium">
        {label}
        {required ? <span className="text-destructive" aria-hidden="true"> *</span> : null}
      </legend>
      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((i) => (
          <label key={i} className="cursor-pointer rounded p-1 has-focus-visible:outline-2 has-focus-visible:outline-ring">
            <input
              type="radio"
              name={name}
              value={i}
              checked={value === i}
              onChange={() => onChange(i)}
              className="sr-only"
              aria-label={`${i} star${i === 1 ? "" : "s"}`}
              required={required}
            />
            <Star
              aria-hidden="true"
              className={cn("size-7", value !== null && i <= value ? "fill-amber-400 text-amber-500" : "text-muted-foreground/50")}
            />
          </label>
        ))}
      </div>
      {error ? <p className="text-sm font-medium text-destructive">{error}</p> : null}
    </fieldset>
  );
}
