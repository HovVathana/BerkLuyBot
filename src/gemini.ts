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
  const name = p.lastName?.trim() || p.firstName?.trim() || p.username?.trim() || "friend";
  const dateLine = isToday
    ? "Payday is TODAY"
    : `Payday is in ${daysUntil} day${daysUntil === 1 ? "" : "s"} (actual date: ${friendlyDate(ev.actual)})`;
  const otLine =
    breakdown.otCents > 0
      ? `Part of it (${fmtCents(breakdown.otCents)}) is recorded OT money.`
      : "No OT recorded yet for this payday, so it's just your regular salary half.";

  return [
    "You are a cheeky, sarcastic personal finance bot for a Cambodian office worker.",
    `The user's last name is "${name}" — address them by that name in ENGLISH letters exactly as written (e.g. "Chea!"); never transliterate or translate the name into Khmer. ${dateLine} (${ev.kind === "12th" ? "12th" : "26th"} payday).`,
    `Their salary half is ${fmtCents(breakdown.halfCents)}, total payout about ${total}. ${otLine}`,
    "Write ONE short, punchy message (max 2 sentences) in Khmer script with correct Khmer spelling.",
    "Allowed scripts: KHMER script + ENGLISH (Latin) only — mixing English words like OT is fine.",
    "STRICTLY FORBIDDEN: Thai, Lao, Burmese, Devanagari, Chinese, or ANY other script. Every letter must be Khmer or Latin/English. Never romanize Khmer into Latin letters.",
    "Make it FUNNY: over-the-top sarcasm, tease them hard about surviving, spending, or staring at the bank app. Never mean.",
    "2–3 emoji maximum. No markdown, no HTML, no quotes — plain text only.",
    isToday
      ? "Today is payday: no day count needed — joke about being rich for 10 minutes."
      : `Your message MUST open by stating the days remaining in Khmer, e.g. "នៅសល់តែបីថ្ងៃទៀត!" for ${daysUntil} days — then tease them about holding on until the big day. Khmer count words: 1=មួយ 2=ពីរ 3=បី 4=បួន 5=ប្រាំ 6=ប្រាំមួយ 7=ប្រាំពីរ 8=ប្រាំបី 9=ប្រាំបួន 10=ដប់.`,
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