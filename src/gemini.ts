import { fmtCents } from "./format.js";
import { friendlyDate } from "./payday.js";
import type { PaydayBreakdown } from "./messages.js";
import type { Profile } from "./types.js";

const KEY = process.env.GEMINI_API_KEY;
const MODELS = (process.env.GEMINI_MODELS ?? "gemini-2.5-flash")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

interface ReminderContext {
  p: Profile;
  breakdown: PaydayBreakdown;
  daysUntil: number;
}

async function callModel(model: string, prompt: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(KEY ?? "")}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 1, candidateCount: 1, responseMimeType: "text/plain" },
        }),
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return text && text.length > 0 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildPrompt(c: ReminderContext): string {
  const { p, breakdown, daysUntil } = c;
  const ev = breakdown.ev;
  const isToday = daysUntil === 0;
  const total = breakdown.otCents > 0 ? breakdown.halfCents + breakdown.otCents : breakdown.halfCents;
  const name = p.firstName?.trim() || p.username?.trim() || "friend";
  const dateLine = isToday
    ? "Payday is TODAY"
    : `Payday is in ${daysUntil} day${daysUntil === 1 ? "" : "s"} (actual date: ${friendlyDate(ev.actual)})`;
  const otLine =
    breakdown.otCents > 0
      ? `Part of it (${fmtCents(breakdown.otCents)}) is recorded OT money — you actually earned it.`
      : "No OT recorded yet for this payday, so it's just your regular salary half.";

  return [
    "You are a cheeky, sarcastic personal finance bot for a Cambodian office worker.",
    `The user is called ${name}. ${dateLine} (${ev.kind === "12th" ? "12th" : "26th"} payday).`,
    `Their salary half is ${fmtCents(breakdown.halfCents)} and the total payout will be about ${total}. ${otLine}`,
    "",
    "Write ONE short message (1–3 sentences) entirely in KHMER (Khmer script).",
    "Make it FUNNY and playfully sarcastic — tease them about surviving until payday, spending, or budgeting. Never be mean.",
    "Use emoji. No markdown, no HTML, no quotes, no code fences — plain text only.",
    "End with a short punchy closing line with emoji.",
    isToday
      ? "Since payment hits today, the joke should be about finally being rich for 10 minutes, or not looking at the bank app."
      : "The joke should tease them about holding on / waiting for the big day.",
  ].join("\n");
}

// Generates a Khmer, funny-sarcastic reminder via Gemini. Returns null when
// disabled (no key) or every configured model fails — callers must fall back.
export async function aiReminderText(c: ReminderContext): Promise<string | null> {
  if (!KEY) return null;
  const prompt = buildPrompt(c);
  const models = MODELS.length > 0 ? MODELS : ["gemini-2.5-flash"];
  for (const model of models) {
    const text = await callModel(model, prompt);
    if (text) return text;
  }
  return null;
}