import { bot } from "../src/bot.js";

// Vercel Node function that receives every Telegram update.
// Vercel already parses the JSON body into `req.body`, so we feed it straight
// into grammY. Respond 200 before Telegram retries the update.
export default async function handler(
  req: { headers: Record<string, string | undefined>; body?: unknown },
  res: { status: (c: number) => { json: (o: unknown) => void } },
): Promise<void> {
  const secret = process.env.TELEGRAM_SECRET_TOKEN;
  const header = req.headers["x-telegram-bot-api-secret-token"];
  if (secret && header !== secret) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (!req.body) {
    res.status(400).json({ error: "no update body" });
    return;
  }
  try {
    await bot.handleUpdate(req.body as Parameters<typeof bot.handleUpdate>[0]);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("webhook error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
}