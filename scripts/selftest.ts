// Verifies the official OT formula and payday rules against the example in the
// spec. Run with: npm test

import {
  baseHourlyCents,
  computeOt,
  otRateCents,
  parseSalaryToCents,
  parseTimes,
} from "../src/payroll.js";
import {
  adjustToActual,
  dayDiff,
  nextPaydayEvent,
  paydayEvents,
} from "../src/payday.js";
import { fmtCents } from "../src/format.js";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ->  ${JSON.stringify(actual)}`);
  if (!ok) {
    console.log(`      expected ${JSON.stringify(expected)}`);
    failures++;
  }
}

// --- Money / rates -----------------------------------------------------
check("parseSalaryToCents('470')", parseSalaryToCents("470"), 47000);
check("parseSalaryToCents('470.50')", parseSalaryToCents("470.50"), 47050);
check("parseSalaryToCents('$1,234.56')", parseSalaryToCents("$1,234.56"), 123456);
check("baseHourlyCents(47000) => $2.71", baseHourlyCents(47000), 271);
check("D rate => $2.71", otRateCents(47000, "D"), 271);
check("N rate => $4.07", otRateCents(47000, "N"), 407);
check("A rate => $5.42", otRateCents(47000, "A"), 542);

// Official Excel formula example: $500 salary
check("500: D rate => $2.88", otRateCents(50000, "D"), 288);
check("500: N rate => $4.33", otRateCents(50000, "N"), 433);
check("500: A rate => $5.77", otRateCents(50000, "A"), 577);
check("500: base hourly => $2.88", baseHourlyCents(50000), 288);

// Changing the salary only affects NEW records; a historical OT record keeps
// the rate/amount that were stored when it was recorded.
const fiveHundred = parseTimes("09:00-17:00")!;
const historical = computeOt(50000, "N", fiveHundred.startMin, fiveHundred.endMin);
check("historical rate stored at $500", historical.rateCents, 433);
check("historical amount stored at $500 (7h x $4.33)", historical.amountCents, 3031);
check("later salary $800 would give $6.92/h", otRateCents(80000, "N"), 692);
check("historical amount unchanged despite new salary", historical.amountCents, 3031);

// --- OT times & break rule ---------------------------------------------
const fullDay = parseTimes("09:00-17:00")!; // 8h
const computedFull = computeOt(47000, "N", fullDay.startMin, fullDay.endMin);
check("full-day duration 8h", computedFull.hours, 8);
check("full-day break -1h", computedFull.breakHours, 1);
check("full-day paid 7h", computedFull.paidHours, 7);
check("full-day N amount $28.49", computedFull.amountCents, 2849);

const evening = parseTimes("16:30-18:30")!; // 2h
const computedEvening = computeOt(47000, "N", evening.startMin, evening.endMin);
check("evening duration 2h", computedEvening.hours, 2);
check("evening no break", computedEvening.breakHours, 0);
check("evening paid 2h", computedEvening.paidHours, 2);
check("evening N amount $8.14", computedEvening.amountCents, 814);

// Weekend full day: 8h - 1h break, rate $5.42
const weekend = parseTimes("08:00-16:00")!;
const computedWeekend = computeOt(47000, "A", weekend.startMin, weekend.endMin);
check("weekend paid 7h", computedWeekend.paidHours, 7);
check("weekend A rate $5.42", computedWeekend.rateCents, 542);
check("weekend A amount $37.94", computedWeekend.amountCents, 3794);

// --- Payday adjustment (April 2026: 12th & 26th are Sundays) ------------
check("12 Apr 2026 (Sun) -> 10 Apr (Fri)", adjustToActual("2026-04-12"), "2026-04-10");
check("26 Apr 2026 (Sun) -> 24 Apr (Fri)", adjustToActual("2026-04-26"), "2026-04-24");

const ev = nextPaydayEvent("2026-04-10");
check("on actual 12th payday, kind 12th", ev?.kind, "12th");
check("on actual 12th payday, actual today", ev?.actual, "2026-04-10");
const ev2 = nextPaydayEvent("2026-04-11");
check("next after 12th actual is the 26th", ev2?.kind, "26th");
check("26th actual for Apr 2026", ev2?.actual, "2026-04-24");
check("days 11 -> 24 = 13", dayDiff("2026-04-11", "2026-04-24"), 13);

const events = paydayEvents("2026-04-13");
check("4 upcoming events", events.length, 4);
check("first raw event is the 12th of April", events[0], {
  kind: "12th",
  month: "2026-04",
  scheduled: "2026-04-12",
  actual: "2026-04-10",
});
const next = events.filter((e) => e.actual >= "2026-04-13").sort((a, b) => (a.actual < b.actual ? -1 : 1));
check("first upcoming (actual >= today) is the 26th", next[0], {
  kind: "26th",
  month: "2026-04",
  scheduled: "2026-04-26",
  actual: "2026-04-24",
});

// --- Example from the spec: $470 salary ----------------------------------
check("monthly total with $151.76 OT = $621.76", fmtCents(47000 + 15176), "$621.76");
check("12th payment = $235.00", fmtCents(Math.round(47000 / 2)), "$235.00");
check(
  "26th payment = $235 + $151.76 = $386.76",
  fmtCents((47000 - Math.round(47000 / 2)) + 15176),
  "$386.76",
);

console.log("");
if (failures > 0) {
  console.error(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("All checks passed.");