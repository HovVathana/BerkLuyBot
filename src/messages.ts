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
    `Monthly salary  <b>${fmtCents(s)}</b>`,
    `Base hourly    <b>${fmtCents(baseHourlyCents(s))}/h</b>`,
    "",
    "<b>OT hourly rates</b>",
    `▸ D · Holiday (100%)   <b>${fmtCents(otRateCents(s, "D"))}/h</b>`,
    `▸ N · Evening (150%)   <b>${fmtCents(otRateCents(s, "N"))}/h</b>`,
    `▸ A · Weekend (200%)   <b>${fmtCents(otRateCents(s, "A"))}/h</b>`,
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
    `Salary        <b>${fmtCents(s)}</b>`,
    `OT records    <b>${totals.count}</b>`,
    `OT hours      <b>${fmtHours(totals.paidHours)}</b>`,
    `OT earnings   <b>${fmtCents(otAmt)}</b>`,
    "",
    `◽ 12th payday  <b>${fmtCents(got12)}</b>  (salary half)`,
    `◾ 26th payday  <b>${fmtCents(got26)}</b>  (half + OT)`,
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
    return `No OT records for ${monthLabel(monthKey)} yet.\nRecord one with /ot.`;
  }
  const lines = records.map((r, i) => {
    const times = `${r.startTime}–${r.endTime}`;
    const breakNote =
      r.breakHours > 0 ? ` (incl. ${fmtHours(r.breakHours)}h break)` : "";
    return (
      `<b>#${i + 1}</b> · ${friendlyDate(r.date)} · ${esc(OT_NAMES[r.otType])}\n` +
      `   ${times} → <b>${fmtHours(r.paidHours)}h</b>${breakNote} × ${fmtCents(r.rateCents)}/h = <b>${fmtCents(r.amountCents)}</b>`
    );
  });
  return [
    `<b>📋 OT records — ${monthLabel(monthKey)}</b>`,
    "",
    ...lines,
    "",
    `✨ Totals: <b>${totals.count}</b> records · <b>${fmtHours(totals.paidHours)}h</b> paid · <b>${fmtCents(totals.amountCents)}</b>`,
    "",
    "Delete one with <b>/del &lt;index&gt;</b> (e.g. /del 3), optionally /del &lt;index&gt; YYYY-MM.",
  ].join("\n");
}

export function otPreviewText(state: OtState, p: Profile): string {
  const c = state.computed!;
  const lines = [
    "<b>🧾 Confirm OT entry</b>",
    "",
    `Type: <b>${OT_NAMES[state.otType!]}</b>`,
    `Date: <b>${friendlyDate(state.date!)}</b>`,
    `Time: <b>${state.startTime}–${state.endTime}</b>`,
    `Duration: <b>${fmtHours(c.hours)}h</b>`,
    c.breakHours > 0 ? `Break: <b>−${fmtHours(c.breakHours)}h</b>` : "",
    `Paid hours: <b>${fmtHours(c.paidHours)}h</b>`,
    `Rate: <b>${fmtCents(c.rateCents)}/h</b>`,
    "",
    `<b>💰 Amount: ${fmtCents(c.amountCents)}</b>`,
  ].filter(Boolean);
  return lines.join("\n");
}

export function otSavedText(record: OtRecord): string {
  return [
    `<b>✅ Saved OT #${record.id}</b>`,
    `${OT_NAMES[record.otType]} · ${friendlyDate(record.date)}`,
    `${record.startTime}–${record.endTime} → <b>${fmtHours(record.paidHours)}h</b> paid × ${fmtCents(record.rateCents)}/h = <b>${fmtCents(record.amountCents)}</b>`,
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
    `Actual: <b>${friendlyDate(b.ev.actual)}</b>`,
    `Salary (half): <b>${fmtCents(b.halfCents)}</b>`,
  ];
  if (b.otCents > 0) {
    lines.push(`OT (${monthLabel(b.ev.month)}): <b>${fmtCents(b.otCents)}</b>`);
  }
  lines.push(`<b>💰 Payout: ${fmtCents(total)}</b>`);
  return lines.join("\n");
}

export function paydayCoverText(p: Profile): string {
  return `<b>💰 Upcoming paydays</b>\nSalary: <b>${fmtCents(p.salaryCents!)}</b>`;
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
    `Actual payday: <b>${friendlyDate(b.ev.actual)}</b>`,
    `It was scheduled for ${shortDate(b.ev.scheduled)}${b.ev.actual !== b.ev.scheduled ? " (moved from a weekend/holiday)" : ""}.`,
    "",
    `Salary (half): <b>${fmtCents(b.halfCents)}</b>`,
  ];
  if (b.otCents > 0) {
    lines.push(`OT (${monthLabel(b.ev.month)}): <b>${fmtCents(b.otCents)}</b>`);
  }
  lines.push(`<b>💰 Total: ${fmtCents(total)}</b>`);
  lines.push("", isToday
    ? "Enjoy your payday! 🎉"
    : `Make sure your OT is recorded before then — use /ot.`);
  return lines.join("\n");
}