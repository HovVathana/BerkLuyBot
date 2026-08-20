import { dayDiff, nextPaydayEvent, todayInTz } from "../src/payday.js";
import { getOtMonthTotals, listProfilesWithSalary, tryMarkNotification } from "../src/storage.js";
import { paydayNotificationText } from "../src/messages.js";
import type { PaydayBreakdown } from "../src/messages.js";

const TZ = process.env.TZ || "Asia/Phnom_Penh";
const REMIND_DAYS = Number(process.env.REMIND_DAYS_BEFORE ?? 3);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function sendPrivate(userId: number, text: string): Promise<boolean> {
  if (!BOT_TOKEN) return false;
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: userId, text, parse_mode: "HTML" }),
  });
  const json = (await res.json()) as { ok: boolean };
  return json.ok === true;
}

function authorized(req: { headers: Record<string, string | undefined> }): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // refuse to run without a configured secret
  const header = req.headers["x-cron-secret"];
  const bearer = req.headers.authorization;
  return header === secret || bearer === `Bearer ${secret}`;
}

export default async function handler(
  req: { headers: Record<string, string | undefined> },
  res: { status: (c: number) => { json: (o: unknown) => void } },
): Promise<void> {
  if (!authorized(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  try {
    const today = todayInTz(TZ);
    const profiles = await listProfilesWithSalary();

    let sent = 0;
    let skipped = 0;
    for (const p of profiles) {
      const ev = nextPaydayEvent(today);
      if (!ev) {
        skipped++;
        continue;
      }
      const daysUntil = dayDiff(today, ev.actual);
      if (daysUntil < 0 || daysUntil > REMIND_DAYS) {
        skipped++;
        continue;
      }

      const kind: "reminder" | "payday" = daysUntil === 0 ? "payday" : "reminder";

      // 12th pays half the salary; the 26th pays the other half + that month's OT.
      const half = Math.round(p.salaryCents! / 2);
      const otherHalf = p.salaryCents! - half;

      // Dedupe so a given event only nudges once per kind.
      const eventKey = `${ev.month}:${ev.kind}:${ev.actual}`;
      const isNew = await tryMarkNotification(p.userId, eventKey, kind);
      if (!isNew) {
        skipped++;
        continue;
      }

      let otCents = 0;
      if (ev.kind === "26th") {
        const [y, m] = ev.month.split("-").map(Number);
        otCents = (await getOtMonthTotals(p.userId, y, m)).amountCents;
      }

      const breakdown: PaydayBreakdown = {
        ev,
        halfCents: ev.kind === "12th" ? half : otherHalf,
        otCents,
      };
      const text = paydayNotificationText(p, breakdown, daysUntil);

      const ok = await sendPrivate(p.userId, text);
      if (ok) sent++;
      else skipped++;
    }

    res.status(200).json({ ok: true, today, sent, skipped });
  } catch (err) {
    console.error("payday cron error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
}