import { dayDiff, nextPaydayEvent, todayInTz } from "../src/payday.js";
import { getOtMonthTotals, listProfilesWithSalary, tryMarkNotification } from "../src/storage.js";
import { paydayNotificationText } from "../src/messages.js";
import { aiReminderText } from "../src/gemini.js";
import type { PaydayBreakdown } from "../src/messages.js";

const TZ = process.env.APP_TZ || "Asia/Phnom_Penh";
const REMIND_DAYS = Number(process.env.REMIND_DAYS_BEFORE ?? 10);
const TESTING = String(process.env.TESTING ?? "").toLowerCase() === "true";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const USE_AI = process.env.GEMINI_API_KEY ? true : false;

async function sendPrivate(
  userId: number,
  text: string,
  plain = false,
): Promise<{ ok: boolean; reason?: string }> {
  if (!BOT_TOKEN) return { ok: false, reason: "TELEGRAM_BOT_TOKEN not set" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: userId,
        text,
        ...(plain ? {} : { parse_mode: "HTML" }),
      }),
    });
    const json = (await res.json()) as { ok?: boolean; description?: string };
    if (json.ok === true) return { ok: true };
    return { ok: false, reason: `HTTP ${res.status}: ${json.description ?? "unknown error"}` };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
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
    const errors: string[] = [];
    for (const p of profiles) {
      const ev = nextPaydayEvent(today);
      if (!ev) {
        skipped++;
        continue;
      }
      const daysUntil = dayDiff(today, ev.actual);
      // Remind every day within the window: from REMIND_DAYS_BEFORE days
      // before the actual payday up to and including payday itself.
      // TESTING=true additionally bypasses the dedup below.
      if (daysUntil < 0 || daysUntil > REMIND_DAYS) {
        skipped++;
        continue;
      }

      const kind: "reminder" | "payday" = daysUntil === 0 ? "payday" : "reminder";

      // 12th pays half the salary; the 26th pays the other half + that month's OT.
      const half = Math.round(p.salaryCents! / 2);
      const otherHalf = p.salaryCents! - half;

      // Dedupe per DAY (event key includes today) so the daily cron sends one
      // reminder per day through the whole window. TESTING=true skips this so
      // every manual run delivers.
      if (!TESTING) {
        const eventKey = `${ev.month}:${ev.kind}:${ev.actual}:${today}`;
        const isNew = await tryMarkNotification(p.userId, eventKey, kind);
        if (!isNew) {
          skipped++;
          continue;
        }
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

      // AI writes a funny, sarcastic Khmer nudge; fall back to the standard
      // reminder whenever AI is disabled or every configured model fails.
      let text: string;
      let plain = false;
      if (USE_AI) {
        const ai = await aiReminderText({ p, breakdown, daysUntil });
        if (ai) {
          text = ai;
          plain = true;
        } else {
          text = paydayNotificationText(p, breakdown, daysUntil);
        }
      } else {
        text = paydayNotificationText(p, breakdown, daysUntil);
      }

      const r = await sendPrivate(p.userId, text, plain);
      if (r.ok) {
        sent++;
      } else {
        skipped++;
        errors.push(`user ${p.userId}: ${r.reason}`);
        console.error("payday send failed:", r.reason);
      }
    }

    res.status(200).json({ ok: true, today, sent, skipped, errors });
  } catch (err) {
    console.error("payday cron error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
}