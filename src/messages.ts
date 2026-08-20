import { esc, fmtCents, fmtHours } from "./format.js";
import { friendlyDate, monthLabel, shortDate } from "./payday.js";
import { baseHourlyCents, OT_NAMES, otRateCents } from "./payroll.js";
import type {
  CalendarEvent,
} from "./payday.js";
import type { MonthTotals, OtComputed, OtRecord, OtState, Profile } from "./types.js";

export function salaryText(p: Profile): string {
  const s = p.salaryCents!;
  const lines = [
    "<b>💼 Your salary &amp; rates</b>",
    "",
    `Monthly salary: ${fmtCents(s)}`,
    `Base hourly: ${fmtCents(baseHourlyCents(s))}/h`,
    "",
    "<b>OT hourly rates</b>",
    `▸ D • Holiday (100%)  ${fmtCents(otRateCents(s, "D"))}/h`,
    `▸ N • Evening (150%)  ${fmtCents(otRateCents(s, "N"))}/h`,
    `▸ A • Weekend (200%)  ${fmtCents(otRateCents(s, "A"))}/h`,
    "",
    "Paydays are the 12th and 26th, moved to the previous working day when they fall on a weekend or public holiday.",
  ];
  return lines.join("\n");
}

export function monthText(
  p: Profile,
  monthKey: string,
  totals: MonthTotals,
): string {
  const s = p.salaryCents!;
  const half = Math.round(s / 2);
  const otherHalf = s - half;
  const otAmt = totals.amountCents;
  const got12 = Math.round(s / 2);
  const got26 = otherHalf + otAmt;
  const expected = s + otAmt;

  const lines = [
    `<b>📊 Salary &amp; OT — ${monthLabel(monthKey)}</b>`,
    "",
    `Salary: ${fmtCents(s)}`,
    `OT records: ${totals.count}`,
    `OT hours (paid): ${fmtHours(totals.paidHours)}`,
    `OT earnings: ${fmtCents(otAmt)}`,
    "",
    `◽ 12th payday: ${fmtCents(got12)}  (salary half)`,
    `◾ 26th payday: ${fmtCents(got26)}  (half + OT)`,
    "",
    `<b>💰 Expected total: ${fmtCents(expected)}</b>`,
  ];
  return lines.join("\n");
}

export function otListText(
  records: OtRecord[],
  monthKey: string,
  totals: MonthTotals,
): string {
  if (records.length === 0) {
    return `No OT records for ${monthLabel(monthKey)}. Record one with /ot.`;
  }
  const lines = records.map((r) => {
    const times = `${r.startTime}–${r.endTime}`;
    const breakNote =
      r.breakHours > 0 ? ` (incl. ${fmtHours(r.breakHours)}h break)` : "";
    return `#<code>${r.id}</code> • ${friendlyDate(r.date)} · ${esc(OT_NAMES[r.otType])}\n  ${times} → ${fmtHours(r.paidHours)}h${breakNote} × ${fmtCents(r.rateCents)}/h = ${fmtCents(r.amountCents)}`;
  });
  return [
    `<b>📋 OT records — ${monthLabel(monthKey)}</b>`,
    "",
    ...lines,
    "",
    `✨ Totals: ${totals.count} records · ${fmtHours(totals.paidHours)}h paid · ${fmtCents(totals.amountCents)}`,
    "",
    "Delete one with /del &lt;id&gt; (e.g. /del 12).",
  ].join("\n");
}

export function otPreviewText(state: OtState, p: Profile): string {
  const c = state.computed!;
  const lines = [
    "<b>🧾 Confirm OT entry</b>",
    "",
    `Type: ${OT_NAMES[state.otType!]}`,
    `Date: ${friendlyDate(state.date!)}`,
    `Time: ${state.startTime}–${state.endTime}`,
    `Duration: ${fmtHours(c.hours)}h`,
    c.breakHours > 0 ? `Break: -${fmtHours(c.breakHours)}h` : "",
    `Paid hours: ${fmtHours(c.paidHours)}h`,
    `Rate: ${fmtCents(c.rateCents)}/h`,
    "",
    `<b>Amount: ${fmtCents(c.amountCents)}</b>`,
  ].filter(Boolean);
  return lines.join("\n");
}

export function otSavedText(record: OtRecord): string {
  return [
    `<b>✅ Saved OT #${record.id}</b>`,
    `${OT_NAMES[record.otType]} • ${friendlyDate(record.date)}`,
    `${record.startTime}–${record.endTime} → ${fmtHours(record.paidHours)}h paid × ${fmtCents(record.rateCents)}/h = ${fmtCents(record.amountCents)}`,
  ].join("\n");
}

export interface PaydayBreakdown {
  ev: CalendarEvent;
  halfCents: number;
  otCents: number;
}

export function paydayBreakdownText(b: PaydayBreakdown): string {
  const total = b.otCents > 0 ? b.halfCents + b.otCents : b.halfCents;
  const lines = [
    `<b>${b.ev.kind === "12th" ? "📅 12th" : "📆 26th"} payday</b>`,
    `Scheduled: ${friendlyDate(b.ev.scheduled)}`,
    `Actual: ${friendlyDate(b.ev.actual)}`,
    `Salary (half): ${fmtCents(b.halfCents)}`,
  ];
  if (b.otCents > 0) {
    lines.push(`OT (${monthLabel(b.ev.month)}): ${fmtCents(b.otCents)}`);
  }
  lines.push(`<b>💰 Payout: ${fmtCents(total)}</b>`);
  return lines.join("\n");
}

export function paydayCoverText(p: Profile): string {
  return `<b>💰 Upcoming paydays</b>\nSalary: ${fmtCents(p.salaryCents!)}`;
}

export function paydayNotificationText(
  p: Profile,
  b: PaydayBreakdown,
  daysUntil: number,
): string {
  const isToday = daysUntil === 0;
  const total = b.halfCents + b.otCents;
  const head = isToday
    ? "<b>💰 Payday is TODAY!</b>"
    : `<b>⏰ Payday reminder</b> · in ${daysUntil} day${daysUntil === 1 ? "" : "s"}`;

  const lines = [
    head,
    `Actual payday: ${friendlyDate(b.ev.actual)}`,
    `It was scheduled for ${shortDate(b.ev.scheduled)}${b.ev.actual !== b.ev.scheduled ? " (moved from a weekend/holiday)" : ""}.`,
    "",
    `Salary (half): ${fmtCents(b.halfCents)}`,
  ];
  if (b.otCents > 0) {
    lines.push(`OT (${monthLabel(b.ev.month)}): ${fmtCents(b.otCents)}`);
  }
  lines.push(`<b>💰 Total: ${fmtCents(total)}</b>`);
  lines.push("", isToday
    ? "Enjoy your payday! 🎉"
    : `Make sure your OT is recorded before then — use /ot.`);
  return lines.join("\n");
}