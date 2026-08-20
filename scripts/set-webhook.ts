// Sets the Telegram webhook to your Vercel deployment URL.
//
// Usage:
//   TELEGRAM_BOT_TOKEN=... npm run webhook:set -- https://your-app.vercel.app/api/webhook
// or
//   TELEGRAM_BOT_TOKEN=... WEBHOOK_URL=https://your-app.vercel.app/api/webhook npm run webhook:set
//
// Optional: pass a third arg "SECRET" to lock the webhook with a secret token
// (set TELEGRAM_SECRET_TOKEN to the same value in Vercel).

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const url = process.argv[2] || process.env.WEBHOOK_URL;
  const secret = process.argv[3] || "";

  if (!token || !url) {
    console.error("Missing TELEGRAM_BOT_TOKEN or webhook URL.");
    console.error(
      "Usage: TELEGRAM_BOT_TOKEN=x npm run webhook:set -- https://app.vercel.app/api/webhook",
    );
    process.exit(1);
  }

  const params = new URLSearchParams({ url });
  if (secret) params.set("secret_token", secret);

  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    body: params,
  });
  const json = (await res.json()) as { ok: boolean; description?: string };
  console.log(JSON.stringify(json, null, 2));
  if (!json.ok) process.exit(1);
}

await main();

export {};