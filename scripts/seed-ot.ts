// Backfills OT records exactly the way the bot stores them (same computeOt
// formula, break rule and rate). Usage:
//
//   tsx --env-file=.env scripts/seed-ot.ts <userId> [file]
//
// Reads lines "YYYY-MM-DD HH:MM HH:MM" from the given file, or from stdin.
// The OT type is derived: weekend -> A (200%), public holiday -> D (100%),
// otherwise N (150%).
import fs from "node:fs";
import { prisma } from "../src/prisma.js";
import { HOLIDAYS } from "../src/holidays.js";
import { computeOt, parseTimes } from "../src/payroll.js";
import { parseDay } from "../src/payday.js";
import { addOtRecord, getProfile } from "../src/storage.js";
import { fmtCents, fmtHours } from "../src/format.js";
import type { OtType } from "../src/types.js";

function deriveType(date: string): OtType {
  if (HOLIDAYS.has(date)) return "D";
  const dow = parseDay(date).getUTCDay();
  return dow === 0 || dow === 6 ? "A" : "N";
}

async function main(): Promise<void> {
  const userId = Number(process.argv[2]);
  const file = process.argv[3];
  if (!userId) {
    console.error("usage: tsx --env-file=.env scripts/seed-ot.ts <userId> [file]");
    process.exit(1);
  }
  const profile = await getProfile(userId);
  if (!profile || !profile.salaryCents) {
    console.error(`no salary set for user ${userId}`);
    process.exit(1);
  }
  const input = file ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8");
  const lines = input
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let totalCents = 0;
  let count = 0;
  for (const line of lines) {
    const m = /^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})$/.exec(line);
    if (!m) {
      console.error(`SKIP (bad line): ${line}`);
      continue;
    }
    const [, date, start, end] = m;
    const parsed = parseTimes(`${start}-${end}`);
    if (!parsed) {
      console.error(`SKIP (bad times): ${line}`);
      continue;
    }
    const otType = deriveType(date);
    const computed = computeOt(profile.salaryCents, otType, parsed.startMin, parsed.endMin);
    await addOtRecord({
      userId,
      date,
      startTime: start,
      endTime: end,
      otType,
      hours: computed.hours,
      breakHours: computed.breakHours,
      paidHours: computed.paidHours,
      rateCents: computed.rateCents,
      amountCents: computed.amountCents,
    });
    count++;
    totalCents += computed.amountCents;
    console.log(
      `added ${date} ${start}-${end} ${otType} (${fmtHours(computed.paidHours)}h paid) = ${fmtCents(computed.amountCents)}`,
    );
  }
  console.log(`\n${count} record(s), ${fmtCents(totalCents)} total`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
