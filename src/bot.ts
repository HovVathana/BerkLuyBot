import { Bot, Context, InlineKeyboard } from "grammy";
import {
  addOtRecord,
  clearConversation,
  deleteOtRecord,
  ensureProfile,
  getConversation,
  getOtMonthTotals,
  getOtRecords,
  getProfile,
  setConversation,
  setSalary,
} from "./storage.js";
import { computeOt, OT_NAMES, parseSalaryToCents, parseTimes, baseHourlyCents } from "./payroll.js";
import { fmtDay, friendlyDate, monthLabel, parseDay, paydayEvents, todayInTz } from "./payday.js";
import {
  monthText,
  otListText,
  otPreviewText,
  otSavedText,
  paydayBreakdownText,
  paydayCoverText,
  salaryText,
} from "./messages.js";
import { fmtCents, fmtHours } from "./format.js";
import type { OtRecord, OtState, OtType } from "./types.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");
export const bot = new Bot(TOKEN);

let initialized = false;
let initPromise: Promise<void> | null = null;

// grammY requires the bot info (getMe) before it can handle updates. Also
// installs the Telegram "/commands" menu. In serverless every warm instance
// only does this once. (bot.botInfo cannot be safely read before init — it
// throws instead of returning undefined.)
export function ensureBotReady(): Promise<void> {
  if (initialized) return Promise.resolve();
  initPromise ??= bot
    .init()
    .then(async () => {
      await bot.api.setMyCommands([
        { command: "menu", description: "Show the menu" },
        { command: "setsalary", description: "Set monthly salary, e.g. /setsalary 470" },
        { command: "salary", description: "My salary, hourly rate & OT rates" },
        { command: "ot", description: "Record overtime" },
        { command: "otlist", description: "My OT records (optionally YYYY-MM)" },
        { command: "month", description: "Monthly summary & expected payments" },
        { command: "payday", description: "Next paydays (scheduled & actual)" },
        { command: "del", description: "Delete an OT record, e.g. /del 12" },
        { command: "cancel", description: "Cancel the current entry" },
        { command: "help", description: "List all commands" },
      ]);
      initialized = true;
    })
    .finally(() => {
      initPromise = null;
    });
  return initPromise;
}

const TZ = process.env.APP_TZ || "Asia/Phnom_Penh";

function fields(ctx: Context) {
  const u = ctx.from!;
  return {
    firstName: u.first_name ?? null,
    lastName: u.last_name ?? null,
    username: u.username ?? null,
  };
}

// ctx.match is only a plain string for slash commands; a helper keeps the
// handlers usable from menu buttons too.
function argOf(ctx: Context): string {
  return typeof ctx.match === "string" ? ctx.match.trim() : "";
}

function helpText(): string {
  return [
    "<b>Commands</b>",
    "/menu              show the menu",
    "/setsalary &lt;amount&gt;  set monthly salary (e.g. /setsalary 470)",
    "/salary              your salary, hourly rate &amp; OT rates",
    "/ot [type] [date] [time]  record OT",
    "/otlist [YYYY-MM]    list OT records for a month",
    "/month [YYYY-MM]     monthly summary &amp; expected payments",
    "/payday              next paydays (scheduled &amp; actual)",
    "/del &lt;id&gt;          delete an OT record",
    "/cancel              cancel the current entry",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Privacy helpers. Sensitive data is always delivered to the user's PRIVATE
// chat, never into a group.
// ---------------------------------------------------------------------------
async function sendPrivate(userId: number, text: string, markup?: InlineKeyboard): Promise<boolean> {
  try {
    await bot.api.sendMessage(userId, text, { parse_mode: "HTML", reply_markup: markup });
    return true;
  } catch {
    return false;
  }
}

async function replySensitive(ctx: Context, text: string, markup?: InlineKeyboard) {
  if (ctx.chat?.type === "private") {
    return ctx.reply(text, { parse_mode: "HTML", reply_markup: markup });
  }
  const from = ctx.from!;
  const ok = await sendPrivate(from.id, text, markup);
  if (ok) {
    return ctx.reply("🔒 Details sent to your private chat with me.", { parse_mode: "HTML" });
  }
  return ctx.reply(
    "I can't show your data here in the group. Please tap me privately first (/start), then try that again.",
    { parse_mode: "HTML" },
  );
}

// ---------------------------------------------------------------------------
// Inline keyboards
// ---------------------------------------------------------------------------
function menuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💰 Payday", "menu:payday").text("💵 Salary", "menu:salary").row()
    .text("➕ Record OT", "menu:ot").text("📋 OT List", "menu:otlist").row()
    .text("📊 Month", "menu:month").text("💵 Set Salary", "menu:setsalary").row()
    .text("❓ Help", "menu:help");
}

function typeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔵 D • Holiday (100%)", "ot:type:D").row()
    .text("🟠 N • Evening (150%)", "ot:type:N").row()
    .text("🟣 A • Weekend (200%)", "ot:type:A").row()
    .text("❌ Cancel", "ot:cancel");
}

function dateKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📅 Today", "ot:date:today").row()
    .text("❌ Cancel", "ot:cancel");
}

function cancelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("❌ Cancel", "ot:cancel");
}

function confirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Save", "ot:confirm:save").row()
    .text("❌ Cancel", "ot:cancel");
}

// ---------------------------------------------------------------------------
// Command implementations — shared by slash commands AND the menu buttons
// ---------------------------------------------------------------------------
async function cmdStart(ctx: Context): Promise<unknown> {
  return ctx.reply(
    `👋 Hello${ctx.from?.first_name ? " " + ctx.from.first_name : ""}!\n\nI track your salary, OT hours and paydays — completely private per Telegram account. Tap an option below or use /help.`,
    { parse_mode: "HTML", reply_markup: menuKeyboard() },
  );
}

async function cmdMenu(ctx: Context): Promise<unknown> {
  return ctx.reply("What would you like to do?", {
    parse_mode: "HTML",
    reply_markup: menuKeyboard(),
  });
}

async function cmdHelp(ctx: Context): Promise<unknown> {
  return ctx.reply(helpText(), { parse_mode: "HTML" });
}

async function cmdSetSalary(ctx: Context): Promise<unknown> {
  const from = ctx.from!;
  const arg = argOf(ctx);
  if (!arg) {
    return ctx.reply("Usage: /setsalary &lt;monthly amount&gt;, e.g. /setsalary 470", {
      parse_mode: "HTML",
    });
  }
  const cents = parseSalaryToCents(arg);
  if (cents === null || cents <= 0) {
    return ctx.reply("That doesn't look like a valid amount. Try e.g. /setsalary 470 or /setsalary 470.50");
  }
  await applySalary(ctx, from.id, cents);
  return undefined;
}

async function cmdSalary(ctx: Context): Promise<unknown> {
  const from = ctx.from!;
  const profile = await getProfile(from.id);
  if (!profile || !profile.salaryCents) {
    return replySensitive(ctx, "Set your salary first with /setsalary &lt;amount&gt;.");
  }
  return replySensitive(ctx, salaryText(profile));
}

async function cmdOt(ctx: Context): Promise<unknown> {
  const from = ctx.from!;
  await ensureProfile(from.id, fields(ctx)).catch(() => {});
  const profile = await getProfile(from.id);
  if (!profile || !profile.salaryCents) {
    return replySensitive(ctx, "Set your salary first: /setsalary 470");
  }

  const args = argOf(ctx);
  const parts = args.split(/\s+/).filter(Boolean);

  // Fast path: /ot A 09:00-17:00  or  /ot A 2026-08-16 09:00-17:00
  if (parts.length === 2 || parts.length === 3) {
    const type = parts[0].toUpperCase() as OtType;
    const hasDate = parts.length === 3;
    const date = hasDate ? parts[1] : todayInTz(TZ);
    const timesText = parts[hasDate ? 2 : 1];

    if (!["D", "N", "A"].includes(type)) {
      return ctx.reply("Unknown OT type. Use D (holiday), N (evening) or A (weekend).");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || fmtDay(parseDay(date)) !== date) {
      return ctx.reply("The date should look like 2026-08-16.");
    }
    const parsed = parseTimes(timesText);
    if (!parsed) {
      return ctx.reply("The time should look like 09:00-17:00.");
    }
    const computed = computeOt(profile.salaryCents, type, parsed.startMin, parsed.endMin);
    const fmt = (min: number) =>
      `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
    const state: OtState = {
      flow: "ot",
      step: "confirm",
      otType: type,
      date,
      startTime: fmt(parsed.startMin),
      endTime: fmt(parsed.endMin),
      computed,
    };
    await setConversation(from.id, state).catch(() => {});
    return replySensitive(ctx, otPreviewText(state, profile), confirmKeyboard());
  }

  if (parts.length > 0) {
    return ctx.reply("Quick format: /ot A 09:00-17:00 or /ot A 2026-08-16 09:00-17:00. Or just /ot to start the guided flow.");
  }

  // Guided flow: choose the OT type
  const state: OtState = { flow: "ot", step: "type" };
  await setConversation(from.id, state).catch(() => {});
  const text = ["<b>What kind of OT?</b>", "", "D = Holiday (100%)", "N = Evening (150%)", "A = Weekend (200%)"].join("\n");
  return ctx.reply(text, { parse_mode: "HTML", reply_markup: typeKeyboard() });
}

async function cmdOtlist(ctx: Context): Promise<unknown> {
  const from = ctx.from!;
  await ensureProfile(from.id, fields(ctx)).catch(() => {});
  const monthKey = parseMonthArg(argOf(ctx)) ?? todayInTz(TZ).slice(0, 7);
  const [y, m] = monthKey.split("-").map(Number);
  const records = await getOtRecords(from.id, y, m);
  const totals = await getOtMonthTotals(from.id, y, m);
  return replySensitive(ctx, otListText(records, monthKey, totals));
}

async function cmdMonth(ctx: Context): Promise<unknown> {
  const from = ctx.from!;
  await ensureProfile(from.id, fields(ctx)).catch(() => {});
  const profile = await getProfile(from.id);
  if (!profile || !profile.salaryCents) {
    return replySensitive(ctx, "Set your salary first: /setsalary 470");
  }
  const monthKey = parseMonthArg(argOf(ctx)) ?? todayInTz(TZ).slice(0, 7);
  const [y, m] = monthKey.split("-").map(Number);
  const totals = await getOtMonthTotals(from.id, y, m);
  return replySensitive(ctx, monthText(profile, monthKey, totals));
}

async function cmdPayday(ctx: Context): Promise<unknown> {
  const from = ctx.from!;
  await ensureProfile(from.id, fields(ctx)).catch(() => {});
  const profile = await getProfile(from.id);
  if (!profile || !profile.salaryCents) {
    return replySensitive(ctx, "Set your salary first: /setsalary 470");
  }
  const today = todayInTz(TZ);
  const events = paydayEvents(today)
    .filter((e) => e.actual >= today)
    .sort((a, b) => (a.actual < b.actual ? -1 : 1))
    .slice(0, 2);

  const half = Math.round(profile.salaryCents / 2);
  const blocks: { ev: (typeof events)[number]; halfCents: number; otCents: number }[] = [];
  for (const ev of events) {
    let ot = 0;
    if (ev.kind === "26th") {
      const [y, m] = ev.month.split("-").map(Number);
      ot = (await getOtMonthTotals(from.id, y, m)).amountCents;
    }
    blocks.push({ ev, halfCents: half, otCents: ot });
  }
  const text = [paydayCoverText(profile), "", ...blocks.map((b) => paydayBreakdownText(b))].join("\n");
  return replySensitive(ctx, text);
}

async function cmdDel(ctx: Context): Promise<unknown> {
  const from = ctx.from!;
  const parts = argOf(ctx).split(/\s+/).filter(Boolean);
  const n = Number(parts[0]);
  if (!Number.isInteger(n) || n <= 0) {
    return ctx.reply("Usage: /del &lt;index&gt; (e.g. /del 3) or /del &lt;index&gt; YYYY-MM. Indices come from /otlist.");
  }
  const monthKey = parseMonthArg(parts[1]) ?? todayInTz(TZ).slice(0, 7);
  const [y, m] = monthKey.split("-").map(Number);
  const records = await getOtRecords(from.id, y, m);
  const rec = records[n - 1];
  if (!rec) {
    return ctx.reply(
      `Index ${n} is out of range — ${monthLabel(monthKey)} has ${records.length} record${records.length === 1 ? "" : "s"} (indices 1–${records.length}).`,
    );
  }
  await deleteOtRecord(from.id, rec.id);
  return ctx.reply(
    `🗑️ Deleted OT #${n} • ${friendlyDate(rec.date)} · ${OT_NAMES[rec.otType]}, ${fmtCents(rec.amountCents)}.`,
  );
}

async function cmdCancel(ctx: Context): Promise<unknown> {
  await clearConversation(ctx.from!.id).catch(() => {});
  return ctx.reply("❌ Cancelled.");
}

async function applySalary(ctx: Context, userId: number, cents: number): Promise<unknown> {
  await ensureProfile(userId, fields(ctx)).catch(() => {});
  await setSalary(userId, cents).catch(() => {});
  return replySensitive(
    ctx,
    `✅ Monthly salary set to <b>${fmtCents(cents)}</b>.\n\nBase hourly: ${fmtCents(baseHourlyCents(cents))}/h\nSee /salary for OT rates and /payday for paydays.`,
  );
}

async function menuSetSalary(ctx: Context): Promise<unknown> {
  const from = ctx.from!;
  await ensureProfile(from.id, fields(ctx)).catch(() => {});
  const state: OtState = { flow: "salary", step: "salary" };
  await setConversation(from.id, state).catch(() => {});
  return ctx.reply("💵 Send your monthly salary as a number, e.g. 470 or 470.50", {
    parse_mode: "HTML",
    reply_markup: cancelKeyboard(),
  });
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------
bot.command("start", cmdStart);
bot.command("menu", cmdMenu);
bot.command("help", cmdHelp);
bot.command("setsalary", cmdSetSalary);
bot.command("salary", cmdSalary);
bot.command("ot", cmdOt);
bot.command("otlist", cmdOtlist);
bot.command("month", cmdMonth);
bot.command("payday", cmdPayday);
bot.command("del", cmdDel);
bot.command("cancel", cmdCancel);

// ---------------------------------------------------------------------------
// Callbacks (menu buttons + guided conversation)
// ---------------------------------------------------------------------------
bot.on("callback_query:data", async (ctx) => {
  const from = ctx.from!;
  if (!from) return;
  const data = ctx.callbackQuery.data;
  await ctx.answerCallbackQuery().catch(() => {});
  if (!data.startsWith("ot:") && !data.startsWith("menu:")) return;

  // ---- menu buttons dispatch to the same logic as the slash commands ----
  if (data.startsWith("menu:")) {
    const action = data.slice(5);
    switch (action) {
      case "payday": return cmdPayday(ctx);
      case "salary": return cmdSalary(ctx);
      case "ot": return cmdOt(ctx);
      case "otlist": return cmdOtlist(ctx);
      case "month": return cmdMonth(ctx);
      case "setsalary": return menuSetSalary(ctx);
      case "help": return cmdHelp(ctx);
      default: return;
    }
  }

  const st = await getConversation(from.id).catch(() => null);

  if (data === "ot:cancel") {
    await clearConversation(from.id).catch(() => {});
    await ctx.editMessageText("❌ Cancelled.").catch(() => ctx.reply("❌ Cancelled."));
    return;
  }

  if (data.startsWith("ot:type:")) {
    const type = data.slice("ot:type:".length) as OtType;
    if (!["D", "N", "A"].includes(type)) return;
    const next: OtState = { flow: "ot", step: "date", otType: type };
    await setConversation(from.id, next).catch(() => {});
    const text = `📅 Date for ${OT_NAMES[type]}?\n\nSend a date as YYYY-MM-DD (e.g. 2026-08-15) or press Today.`;
    await ctx
      .editMessageText(text, { parse_mode: "HTML", reply_markup: dateKeyboard() })
      .catch(() => ctx.reply(text, { parse_mode: "HTML", reply_markup: dateKeyboard() }));
    return;
  }

  if (data === "ot:date:today") {
    const date = todayInTz(TZ);
    const next: OtState = { flow: "ot", step: "time", otType: st?.otType, date };
    await setConversation(from.id, next).catch(() => {});
    const text = `🕐 Start and finish time (HH:MM)?\n\nFormat: 09:00-17:00 (dash separated).`;
    await ctx
      .editMessageText(text, { parse_mode: "HTML", reply_markup: cancelKeyboard() })
      .catch(() => ctx.reply(text, { parse_mode: "HTML", reply_markup: cancelKeyboard() }));
    return;
  }

  if (data === "ot:confirm:save") {
    if (!st || st.flow !== "ot" || st.step !== "confirm" || !st.computed) {
      await clearConversation(from.id).catch(() => {});
      await ctx
        .editMessageText("That entry expired — start again with /ot.")
        .catch(() => ctx.reply("That entry expired — start again with /ot."));
      return;
    }
    const profile = await getProfile(from.id);
    if (!profile || !profile.salaryCents) {
      await clearConversation(from.id).catch(() => {});
      return ctx.reply("Set your salary first: /setsalary 470");
    }
    const rec = await addOtRecord({
      userId: from.id,
      date: st.date!,
      startTime: st.startTime!,
      endTime: st.endTime!,
      otType: st.otType!,
      hours: st.computed.hours,
      breakHours: st.computed.breakHours,
      paidHours: st.computed.paidHours,
      rateCents: st.computed.rateCents,
      amountCents: st.computed.amountCents,
    });
    await clearConversation(from.id).catch(() => {});

    // confirmation + running month total
    const [y, m] = st.date!.split("-").map(Number);
    const totals = await getOtMonthTotals(from.id, y, m);
    const saved: OtRecord = {
      id: rec,
      userId: from.id,
      date: st.date!,
      startTime: st.startTime!,
      endTime: st.endTime!,
      otType: st.otType!,
      hours: st.computed.hours,
      breakHours: st.computed.breakHours,
      paidHours: st.computed.paidHours,
      rateCents: st.computed.rateCents,
      amountCents: st.computed.amountCents,
    };
    const text = `${otSavedText(saved)}\n\n📈 ${monthLabel(st.date!)} so far: ${fmtHours(totals.paidHours)}h • ${fmtCents(totals.amountCents)}`;
    await ctx
      .editMessageText(text, { parse_mode: "HTML" })
      .catch(() => ctx.reply(text, { parse_mode: "HTML" }));
    return;
  }
});

// ---------------------------------------------------------------------------
// Free-text input for guided flows (OT date/time + salary amount)
// ---------------------------------------------------------------------------
bot.on("message:text", async (ctx) => {
  const from = ctx.from;
  if (!from) return;
  const st = await getConversation(from.id).catch(() => null);
  if (!st) return;
  const text = ctx.message.text.trim();

  // ---- salary amount entry (from the menu) ----
  if (st.flow === "salary") {
    const cents = parseSalaryToCents(text);
    if (cents === null || cents <= 0) {
      return ctx.reply("Send a valid amount, e.g. 470 or 470.50 (or /cancel).");
    }
    await clearConversation(from.id).catch(() => {});
    return applySalary(ctx, from.id, cents);
  }

  if (st.flow !== "ot") return;

  if (st.step === "date") {
    let date: string | null = null;
    if (/^today$/i.test(text)) {
      date = todayInTz(TZ);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(text) && fmtDay(parseDay(text)) === text) {
      date = text;
    }
    if (!date) {
      return ctx.reply("I couldn't read that date. Use YYYY-MM-DD (e.g. 2026-08-15) or press Today.");
    }
    const next: OtState = { flow: "ot", step: "time", otType: st.otType, date };
    await setConversation(from.id, next).catch(() => {});
    return ctx.reply("🕐 Start and finish time (HH:MM)?\n\nFormat: 09:00-17:00", {
      parse_mode: "HTML",
      reply_markup: cancelKeyboard(),
    });
  }

  if (st.step === "time") {
    const parsed = parseTimes(text);
    if (!parsed) {
      return ctx.reply("I couldn't read that. Use HH:MM-HH:MM, e.g. 09:00-17:00.");
    }
    const profile = await getProfile(from.id);
    if (!profile || !profile.salaryCents) {
      await clearConversation(from.id).catch(() => {});
      return ctx.reply("Set your salary first: /setsalary 470");
    }
    const computed = computeOt(profile.salaryCents, st.otType!, parsed.startMin, parsed.endMin);
    const fmt = (min: number) =>
      `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
    const next: OtState = {
      flow: "ot",
      step: "confirm",
      otType: st.otType,
      date: st.date,
      startTime: fmt(parsed.startMin),
      endTime: fmt(parsed.endMin),
      computed,
    };
    await setConversation(from.id, next).catch(() => {});
    return replySensitive(ctx, otPreviewText(next, profile), confirmKeyboard());
  }
});

function parseMonthArg(arg?: string): string | null {
  if (!arg) return null;
  if (/^\d{4}-\d{2}$/.test(arg) && Number(arg.slice(5, 7)) >= 1 && Number(arg.slice(5, 7)) <= 12) {
    return arg;
  }
  return null;
}

bot.catch((err) => {
  console.error("Bot error:", err);
});