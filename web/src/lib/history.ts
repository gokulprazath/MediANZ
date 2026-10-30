// Effective-dated rows (valid_from inclusive, valid_to exclusive; null = open).
import type { IsoDate } from "@/types/db";

export interface Ranged {
  valid_from: IsoDate;
  valid_to: IsoDate | null;
}

/** daterange(valid_from, valid_to, '[)') @> day */
export function validOn(row: Ranged, day: IsoDate): boolean {
  return row.valid_from <= day && (row.valid_to === null || day < row.valid_to);
}

export function currentRow<T extends Ranged>(rows: T[], day: IsoDate, match: (r: T) => boolean = () => true): T | undefined {
  return rows.find((r) => match(r) && validOn(r, day));
}
