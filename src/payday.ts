import { HOLIDAYS } from "./holidays.js";

// ---------------------------------------------------------------------------
// Calendar helpers. Dates are plain "YYYY-MM-DD" strings, stored/compared in
// UTC so timezones never shift a day.
//
// Paydays are the 12th and 26th. A payday that lands on a weekend or public
// holiday is moved BACK to the previous working day.
// ---------------------------------------------------------------------------

export interface CalendarEvent {
  kind: "12th" | "26th";
  month: string; // "YYYY-MM"
  scheduled: string; // "YYYY-MM-DD" the nominal 12th/26th
  actual: string; // "YYYY-MM-DD" after weekend/holiday adjustment
}

export function parseDay(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function fmtDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function monthOf(s: string): string {
  return s.slice(0, 7);
}

export function nextMonthKey(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/**
 * The month whose OT days are PAID by this month's 26th payout:
 * money arriving in August is July's OT work.
 */
export function prevMonthKey(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

export function addDays(date: string, n: number): string {
  const d = parseDay(date);
  d.setUTCDate(d.getUTCDate() + n);
  return fmtDay(d);
}

/** Number of days from a to b (b - a). a before/after b gives negative/positive. */
export function dayDiff(a: string, b: string): number {
  return Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 86_400_000);
}

/** Today's date as "YYYY-MM-DD" in the configured timezone. */
export function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
}

export function isWorkday(
  date: string,
  holidays: ReadonlySet<string> = HOLIDAYS,
): boolean {
  const dow = parseDay(date).getUTCDay();
  return dow >= 1 && dow <= 5 && !holidays.has(date);
}

export function adjustToActual(
  scheduled: string,
  holidays: ReadonlySet<string> = HOLIDAYS,
): string {
  let d = scheduled;
  while (!isWorkday(d, holidays)) d = addDays(d, -1);
  return d;
}

/** Events for the current month and the next month (2 paydays each). */
export function paydayEvents(
  today: string,
  holidays: ReadonlySet<string> = HOLIDAYS,
): CalendarEvent[] {
  const months = [monthOf(today), nextMonthKey(monthOf(today))];
  const events: CalendarEvent[] = [];
  for (const month of months) {
    for (const kind of ["12th", "26th"] as const) {
      const scheduled = `${month}-${kind === "12th" ? "12" : "26"}`;
      events.push({ kind, month, scheduled, actual: adjustToActual(scheduled, holidays) });
    }
  }
  return events;
}

/** The next payday whose actual date is today or later. */
export function nextPaydayEvent(
  today: string,
  holidays: ReadonlySet<string> = HOLIDAYS,
): CalendarEvent | null {
  const upcoming = paydayEvents(today, holidays)
    .filter((e) => e.actual >= today)
    .sort((a, b) => (a.actual < b.actual ? -1 : 1));
  return upcoming[0] ?? null;
}

export function friendlyDate(s: string): string {
  return parseDay(s).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function shortDate(s: string): string {
  return parseDay(s).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

export function monthLabel(month: string): string {
  const d = parseDay(`${month}-01`);
  return d.toLocaleDateString("en-GB", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}