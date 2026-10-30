// Date and time-zone helpers. Times are always shown in the clinic's time zone
// (facilities.timezone), with the zone label when it differs from the user's.
import type { IsoDate } from "@/types/db";

const DAY_MS = 86_400_000;

export const LOCALE = "en-AU";

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** Postgres `current_date` on Supabase (the database runs in UTC). */
export function todayUtc(now: Date = new Date()): IsoDate {
  return now.toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const t = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) + days * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

export function diffDays(a: IsoDate, b: IsoDate): number {
  const ta = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const tb = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.round((ta - tb) / DAY_MS);
}

/** ISO weekday: 1 = Monday ... 7 = Sunday (Postgres `extract(isodow ...)`). */
export function isoDow(date: IsoDate): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function wallClock(instant: Date, timeZone: string): WallClock {
  let fmt = partsFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatters.set(timeZone, fmt);
  }
  const get = (type: string) =>
    Number(fmt.formatToParts(instant).find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Minutes the zone is ahead of UTC at that instant (Brisbane: 600). */
export function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/** `(date + time)::timestamp at time zone tz`: a wall-clock time in a zone, as an instant. */
export function zonedToUtc(date: IsoDate, time: string, timeZone: string): Date {
  const [h = 0, m = 0, s = 0] = time.split(":").map(Number);
  const guess = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h, m, s);
  let result = guess - tzOffsetMinutes(new Date(guess), timeZone) * 60_000;
  // Re-check once: the offset can differ either side of a daylight-saving change.
  const second = guess - tzOffsetMinutes(new Date(result), timeZone) * 60_000;
  if (second !== result) result = second;
  return new Date(result);
}

/** `(instant at time zone tz)::date` */
export function localDate(instant: Date | string, timeZone: string): IsoDate {
  const w = wallClock(new Date(instant), timeZone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** Wall-clock "HH:MM" in the zone. */
export function localTime(instant: Date | string, timeZone: string): string {
  const w = wallClock(new Date(instant), timeZone);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

export function userTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** True when the clinic's clock differs from the user's at that instant. */
export function zoneDiffers(instant: Date | string, timeZone: string, userZone = userTimeZone()): boolean {
  const at = new Date(instant);
  return tzOffsetMinutes(at, timeZone) !== tzOffsetMinutes(at, userZone);
}

function zoneLabel(instant: Date, timeZone: string): string {
  const name = new Intl.DateTimeFormat(LOCALE, { timeZone, timeZoneName: "short" })
    .formatToParts(instant)
    .find((p) => p.type === "timeZoneName")?.value;
  return name ?? timeZone;
}

export interface FormatOptions {
  /** Add the zone label when it differs from the user's zone (default true). */
  label?: boolean;
  userZone?: string;
}

function withLabel(text: string, instant: Date, timeZone: string, opts: FormatOptions): string {
  if (opts.label === false) return text;
  if (!zoneDiffers(instant, timeZone, opts.userZone)) return text;
  return `${text} ${zoneLabel(instant, timeZone)}`;
}

/** "2:30 pm" in the clinic's zone. */
export function formatTime(iso: string | Date, timeZone: string, opts: FormatOptions = {}): string {
  const at = new Date(iso);
  const text = new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(at)
    .replace(/\s?([ap])\.?m\.?/i, " $1m")
    .toLowerCase();
  return withLabel(text, at, timeZone, opts);
}

/** "Mon 3 Nov 2026" in the clinic's zone. */
export function formatDate(iso: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(iso));
}

/** "Mon 3 Nov 2026, 2:30 pm" in the clinic's zone. */
export function formatDateTime(iso: string | Date, timeZone: string, opts: FormatOptions = {}): string {
  return `${formatDate(iso, timeZone)}, ${formatTime(iso, timeZone, opts)}`;
}

/** A calendar date (no time zone): "Mon 3 Nov 2026". */
export function formatIsoDate(date: IsoDate): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${date}T00:00:00Z`));
}

export function formatShortIsoDate(date: IsoDate): { weekday: string; day: string; month: string } {
  const at = new Date(`${date}T00:00:00Z`);
  const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(LOCALE, { timeZone: "UTC", ...o }).format(at);
  return { weekday: f({ weekday: "short" }), day: f({ day: "numeric" }), month: f({ month: "short" }) };
}

/** Whole years between a date of birth and today. */
export function ageOn(dateOfBirth: IsoDate, today: IsoDate = todayUtc()): number {
  const [by, bm, bd] = dateOfBirth.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

export function minutesBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000);
}

/** "4:59" countdown text. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${pad(total % 60)}`;
}

/**
 * The hours a day/week calendar shows: the usual clinic day, widened to fit
 * any appointment outside it (an evening visit is never hidden).
 */
export function visibleHours(
  events: { start: string; end: string }[],
  timeZone: string,
  usual: [number, number] = [7, 20],
): { slotMinTime: string; slotMaxTime: string } {
  let [lo, hi] = usual;
  for (const e of events) {
    const start = wallClock(new Date(e.start), timeZone);
    const end = wallClock(new Date(e.end), timeZone);
    lo = Math.min(lo, start.hour);
    const sameDay = localDate(e.start, timeZone) === localDate(e.end, timeZone);
    hi = Math.max(hi, !sameDay ? 24 : end.minute > 0 ? end.hour + 1 : end.hour);
  }
  return { slotMinTime: `${pad(lo)}:00:00`, slotMaxTime: `${pad(Math.min(hi, 24))}:00:00` };
}
