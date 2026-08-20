import type { OtComputed, OtType } from "./types.js";

// ---------------------------------------------------------------------------
// Official Excel OT formula
//
//   base hourly = (Monthly Salary x 12) / (40 x 52)     (full precision)
//   OT rate     = ROUND(base hourly x factor, 2)        (rounded once, at the end)
//   D : factor 1.00   (holiday OT)
//   N : factor 1.50   (evening OT)
//   A : factor 2.00   (weekend OT)
//   OT pay      = paid OT hours x OT rate
//
// The rate is NOT computed from an already-rounded base: $500 salary gives
// D $2.88/h, N $4.33/h, A $5.77/h (rounding the base first would wrongly give
// $4.32 / $5.76).
//
// Rates depend on the salary at the time the OT is recorded — each stored OT
// record keeps its own rate_cents/amount_cents, so changing the salary later
// never rewrites history.
//
// All money is held as integer cents so rounding is exact (Math.round = round
// half up).
// ---------------------------------------------------------------------------

export const MONTHS_PER_YEAR = 12;
export const HOURS_PER_WEEK = 40;
export const WEEKS_PER_YEAR = 52;

// Full-day OT deducts a 1-hour break; shorter/evening sessions take no break.
export const BREAK_HOURS = 1;
// A session is treated as a "full day" when it is at least this long.
export const FULL_DAY_MIN_HOURS = 6;

export const OT_NAMES: Record<OtType, string> = {
  D: "Holiday (100%)",
  N: "Evening (150%)",
  A: "Weekend (200%)",
};

export const OT_FACTORS: Record<OtType, number> = {
  D: 1,
  N: 1.5,
  A: 2,
};

/** "470" | "470.50" | "$470" -> 47000 (cents). Returns null when invalid. */
export function parseSalaryToCents(raw: string): number | null {
  const s = raw.trim().replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [intPart, fracPart = ""] = s.split(".");
  return Number(intPart) * 100 + Number(fracPart.padEnd(2, "0"));
}

export function baseHourlyCents(salaryCents: number): number {
  return Math.round(
    (salaryCents * MONTHS_PER_YEAR) / (HOURS_PER_WEEK * WEEKS_PER_YEAR),
  );
}

/**
 * Official Excel OT rate: ROUND((salary x 12) / (40 x 52) x factor, 2).
 * The base hourly rate is used at full precision; only the final rate is
 * rounded to 2 decimal places (integer cents).
 */
export function otRateCents(salaryCents: number, type: OtType): number {
  return Math.round(
    (salaryCents * MONTHS_PER_YEAR * OT_FACTORS[type]) /
      (HOURS_PER_WEEK * WEEKS_PER_YEAR),
  );
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface ParsedTimes {
  startMin: number;
  endMin: number;
}

/** Parses "09:00-17:00" (also accepts en-dash and spaces). */
export function parseTimes(text: string): ParsedTimes | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!m) return null;
  const sh = Number(m[1]);
  const sm = Number(m[2]);
  const eh = Number(m[3]);
  const em = Number(m[4]);
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null;
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (end <= start) return null;
  return { startMin: start, endMin: end };
}

export function durationHours(startMin: number, endMin: number): number {
  return (endMin - startMin) / 60;
}

export function computeOt(
  salaryCents: number,
  type: OtType,
  startMin: number,
  endMin: number,
): OtComputed {
  const hours = round2(durationHours(startMin, endMin));
  const breakHours = hours >= FULL_DAY_MIN_HOURS ? BREAK_HOURS : 0;
  const paidHours = Math.max(0, round2(hours - breakHours));
  const rateCents = otRateCents(salaryCents, type);
  const amountCents = Math.round(paidHours * rateCents);
  return { hours, breakHours, paidHours, rateCents, amountCents };
}