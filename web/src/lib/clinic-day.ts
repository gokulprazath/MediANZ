// A calendar day at a clinic as a [from, to) instant range.
import { addDays, localDate, zonedToUtc } from "@/lib/time";
import type { IsoDate } from "@/types/db";

export function clinicToday(timeZone: string, now = new Date()): IsoDate {
  return localDate(now, timeZone);
}

export function dayRange(date: IsoDate, timeZone: string, days = 1): { from: string; to: string } {
  return {
    from: zonedToUtc(date, "00:00", timeZone).toISOString(),
    to: zonedToUtc(addDays(date, days), "00:00", timeZone).toISOString(),
  };
}
