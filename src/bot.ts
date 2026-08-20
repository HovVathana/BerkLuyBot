import { Bot, Context, InlineKeyboard } from "grammy";
import {
  addOtRecord,
  clearConversation,
  clearSavingGoal,
  deleteOtRecord,
  ensureProfile,
  getConversation,
  getOtMonthTotals,
  getOtRecords,
  getProfile,
  getSavingProgress,
  setConversation,
  setSalary,
  setSavingGoal,
} from "./storage.js";
import { computeOt, OT_NAMES, parseSalaryToCents, parseTimes, baseHourlyCents } from "./payroll.js";
import { fmtDay, friendlyDate, monthLabel, parseDay, paydayEvents, prevMonthKey, todayInTz } from "./payday.js";
import {
  goalText,
  monthText,
  otListText,
  otPreviewText,
  otSavedText,
  paydayBreakdownText,
  paydayCoverText,
  salaryText,
} from "./messages.js";
import type { GoalView } from "./messages.js";
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
        { command: "goal", description: "OT savings goal, e.g. /goal 1000" },
        { command: "payday", description: "Next paydays (scheduled & actual)" },
        { command: "del", description: "Delete an OT record, e.g. /del 3" },
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

const NO_SALARY =
  "💵 You haven't set your salary yet.\n\nSet it with <b>/setsalary</b>, e.g. <b>/setsalary 470</b>.";

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
    "<b>🤖 Commands</b>",
    "",
    "<b>/menu</b> — show the menu",
    "<b>/setsalary</b> &lt;amount&gt; — set monthly salary (e.g. /setsalary 470)",
    "<b>/salary</b> — your salary, hourly rate &amp; OT rates",
    "<b>/ot</b> [type] [date] [time] — record OT",
    "<b>/otlist</b> [YYYY-MM] — list OT records for a month",
    "<b>/month</b> [YYYY-MM] — monthly summary &amp; expected payments",
    "<b>/goal</b> &lt;amount&gt; — OT savings goal (e.g. /goal 1000; /goal 0 to remove)",
    "<b>/payday</b> — next paydays (scheduled &amp; actual)",
    "<b>/del</b> &lt;index&gt; — delete an OT record (see /otlist)",
    "<b>/cancel</b> — cancel the current entry",
    "",
    "Quick OT: <b>/ot A 09:00-17:00</b> or <b>/ot A 2026-08-16 09:00-17:00</b>",
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
    return ctx.reply("🔒 <b>Details sent to your private chat</b> with me.", { parse_mode: "HTML" });
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
    .text("🎯 Goal", "menu:goal").text("❓ Help", "menu:help");
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
    `👋 Hello${ctx.from?.first_name ? " " + ctx.from.first_name : ""}!\n\nI track your <b>salary</b>, <b>OT hours</b> and <b>paydays</b> — completely private per Telegram account. Tap an option below or use /help.`,
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
    return ctx.reply("<b>Usage:</b> /setsalary &lt;monthly amount&gt;, e.g. <b>/setsalary 470</b>", {
      parse_mode: "HTML",
    });
  }
  const cents = parseSalaryToCents(arg);
  if (cents === null || cents <= 0) {
    return ctx.reply("That doesn't look like a valid amount.\nTry e.g. <b>/setsalary 470</b> or <b>/setsalary 470.50</b>.");
  }
  await applySalary(ctx, from.id, cents);
  return undefined;
}

async function cmdSalary(ctx: Context): Promise<unknown> {
  const from = ctx.from!;
  const profile = await getProfile(from.id);
  if (!profile || !profile.salaryCents) {
    return replySensitive(ctx, NO_SALARY);
  }
  return replySensitive(ctx, salaryText(profile));
}

async function cmdOt(ctx: Context): Promise<unknown> {
  const from = ctx.from!;
  await ensureProfile(from.id, fields(ctx)).catch(() => {});
  const profile = await getProfile(from.id);
  if (!profile || !profile.salaryCents) {
    return replySensitive(ctx, NO_SALARY);
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
      return ctx.reply("Unknown OT type. Use <b>D</b> (holiday), <b>N</b> (evening) or <b>A</b> (weekend).");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || fmtDay(parseDay(date)) !== date) {
      return ctx.reply("The date should look like <b>2026-08-16</b>.");
    }
    const parsed = parseTimes(timesText);
    if (!parsed) {
      return ctx.reply("The time should look like <b>09:00-17:00</b>.");
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
    return ctx.reply("Quick format: <b>/ot A 09:00-17:00</b> or <b>/ot A 2026-08-16 09:00-17:00</b>.\nOr just /ot to start the guided flow.");
  }

  // Guided flow: choose the OT type
  const state: OtState = { flow: "ot", step: "type" };
  await setConversation(from.id, state).catch(() => {});
  const text = ["<b>What kind of OT?</b>", "", "🔵 <b>D</b> · Holiday (100%)", "🟠 <b>N</b> · Evening (150%)", "🟣 <b>A</b> · Weekend (200%)"].join("\n");
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
    return replySensitive(ctx, NO_SALARY);
  }
  const monthKey = parseMonthArg(argOf(ctx)) ?? todayInTz(TZ).slice(0, 7);
  const [y, m] = monthKey.split("-").map(Number);
  const totals = await getOtMonthTotals(from.id, y, m);
  const [py, pm] = prevMonthKey(monthKey).split("-").map(Number);
  const payoutOt = await getOtMonthTotals(from.id, py, pm);
  return replySensitive(ctx, monthText(profile, monthKey, totals, payoutOt));
}

async function cmdPayday(ctx: Context): Promise<unknown> {
  const from = ctx.from!;
  await ensureProfile(from.id, fields(ctx)).catch(() => {});
  const profile = await getProfile(from.id);
  if (!profile || !profile.salaryCents) {
    return replySensitive(ctx, NO_SALARY);
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
      const [py, pm] = prevMonthKey(ev.month).split("-").map(Number);
      ot = (await getOtMonthTotals(from.id, py, pm)).amountCents;
    }
    blocks.push({ ev, halfCents: half, otCents: ot });
  }
  const text = [paydayCoverText(profile), "", ...blocks.map((b) => paydayBreakdownText(b))].join("\n");
  return replySensitive(ctx, text);
}

async function cmdGoal(ctx: Context): Promise<unknown> {
  const from = ctx.from!;
  await ensureProfile(from.id, fields(ctx)).catch(() => {});
  const arg = argOf(ctx).toLowerCase();
  const profile = await getProfile(from.id);
  const today = todayInTz(TZ);
  const [yt, mt] = today.split("-").map(Number);
  const m = mt === 1 ? 12 : mt - 1;
  const y = mt === 1 ? yt - 1 : yt;
  const prevMonthKey = `${y}-${String(m).padStart(2, "0")}`;
  const progress =
    (await getSavingProgress(from.id, y, m).catch(() => null)) ?? {
      goalCents: profile?.savingGoalCents ?? 0,
      earnedCents: 0,
      count: 0,
      monthKey: prevMonthKey,
    };
  if (profile?.savingGoalCents) {
    const view: GoalView = progress;
    const suffix = arg ? "\n\n" : "";
    if (arg === "0" || arg === "none" || arg === "off") {
      await clearSavingGoal(from.id).catch(() => {});
      return replySensitive(ctx, `🎯 Goal cleared. Every drop of OT money is yours again.`);
    }
    if (arg) {
      const cents = parseSalaryToCents(argOf(ctx));
      if (cents === null || cents <= 0) {
        return ctx.reply("<b>Usage:</b> /goal &lt;amount&gt;, e.g. <b>/goal 1000</b>. Use <b>/goal 0</b> to clear.");
      }
      await setSavingGoal(from.id, cents).catch(() => {});
      const updated: GoalView = { ...progress, goalCents: cents };
      return replySensitive(ctx, `✅ <b>Goal updated to ${fmtCents(cents)}</b>\n\n${goalText(updated)}`);
    }
    return replySensitive(ctx, goalText(view) + suffix);
  }
  if (arg && !["0", "none", "off"].includes(arg)) {
    const cents = parseSalaryToCents(argOf(ctx));
    if (cents === null || cents <= 0) {
      return ctx.reply("<b>Usage:</b> /goal &lt;amount&gt;, e.g. <b>/goal 1000</b>.");
    }
    await setSavingGoal(from.id, cents).catch(() => {});
    return replySensitive(
      ctx,
      `✅ <b>OT savings goal: ${fmtCents(cents)}</b>\n\nOT you log this month is paid on the 26th of next month — the goal tracks each month's payout. Record hours with /ot.`,
    );
  }
  const state: OtState = { flow: "goal", step: "goal" };
  await setConversation(from.id, state).catch(() => {});
  return ctx.reply("🎯 <b>Set your OT savings goal</b> as a number, e.g. <b>1000</b> (or /goal 0 to clear).", {
    parse_mode: "HTML",
    reply_markup: cancelKeyboard(),
  });
}

async function cmdDel(ctx: Context): Promise<unknown> {
  const from = ctx.from!;
  const parts = argOf(ctx).split(/\s+/).filter(Boolean);
  const n = Number(parts[0]);
  if (!Number.isInteger(n) || n <= 0) {
    return ctx.reply("<b>Usage:</b> /del &lt;index&gt; (e.g. <b>/del 3</b>) — indices come from /otlist. Optionally /del &lt;index&gt; YYYY-MM.");
  }
  const monthKey = parseMonthArg(parts[1]) ?? todayInTz(TZ).slice(0, 7);
  const [y, m] = monthKey.split("-").map(Number);
  const records = await getOtRecords(from.id, y, m);
  const rec = records[n - 1];
  if (!rec) {
    return ctx.reply(
      `<b>Index ${n}</b> is out of range — ${monthLabel(monthKey)} has <b>${records.length}</b> record${records.length === 1 ? "" : "s"} (indices 1–${records.length}).`,
    );
  }
  await deleteOtRecord(from.id, rec.id);
  return ctx.reply(
    `🗑️ <b>Deleted</b> OT #${n} · ${friendlyDate(rec.date)} · ${OT_NAMES[rec.otType]} = <b>${fmtCents(rec.amountCents)}</b>`,
  );
}

async function cmdCancel(ctx: Context): Promise<unknown> {
  await clearConversation(ctx.from!.id).catch(() => {});
  return ctx.reply("❌ <b>Cancelled.</b>");
}

async function applySalary(ctx: Context, userId: number, cents: number): Promise<unknown> {
  await ensureProfile(userId, fields(ctx)).catch(() => {});
  await setSalary(userId, cents).catch(() => {});
  return replySensitive(
    ctx,
    `✅ <b>Monthly salary set to ${fmtCents(cents)}</b>\n\nBase hourly: <b>${fmtCents(baseHourlyCents(cents))}/h</b>\n· /salary for OT rates\n· /payday for paydays`,
  );
}

async function menuSetSalary(ctx: Context): Promise<unknown> {
  const from = ctx.from!;
  await ensureProfile(from.id, fields(ctx)).catch(() => {});
  const state: OtState = { flow: "salary", step: "salary" };
  await setConversation(from.id, state).catch(() => {});
  return ctx.reply("💵 <b>Send your monthly salary</b> as a number, e.g. <b>470</b> or <b>470.50</b>", {
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
bot.command("goal", cmdGoal);
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
      case "goal": return cmdGoal(ctx);
      case "setsalary": return menuSetSalary(ctx);
      case "help": return cmdHelp(ctx);
      default: return;
    }
  }

  const st = await getConversation(from.id).catch(() => null);

  if (data === "ot:cancel") {
    await clearConversation(from.id).catch(() => {});
    await ctx.editMessageText("❌ <b>Cancelled.</b>").catch(() => ctx.reply("❌ <b>Cancelled.</b>"));
    return;
  }

  if (data.startsWith("ot:type:")) {
    const type = data.slice("ot:type:".length) as OtType;
    if (!["D", "N", "A"].includes(type)) return;
    const next: OtState = { flow: "ot", step: "date", otType: type };
    await setConversation(from.id, next).catch(() => {});
    const text = `📅 <b>Date</b> for ${OT_NAMES[type]}?\n\nSend a date as <b>YYYY-MM-DD</b> (e.g. 2026-08-15) or press Today.`;
    await ctx
      .editMessageText(text, { parse_mode: "HTML", reply_markup: dateKeyboard() })
      .catch(() => ctx.reply(text, { parse_mode: "HTML", reply_markup: dateKeyboard() }));
    return;
  }

  if (data === "ot:date:today") {
    const date = todayInTz(TZ);
    const next: OtState = { flow: "ot", step: "time", otType: st?.otType, date };
    await setConversation(from.id, next).catch(() => {});
    const text = `🕐 <b>Start and finish time</b> (HH:MM)?\n\nFormat: <b>09:00-17:00</b> (dash separated).`;
    await ctx
      .editMessageText(text, { parse_mode: "HTML", reply_markup: cancelKeyboard() })
      .catch(() => ctx.reply(text, { parse_mode: "HTML", reply_markup: cancelKeyboard() }));
    return;
  }

  if (data === "ot:confirm:save") {
    if (!st || st.flow !== "ot" || st.step !== "confirm" || !st.computed) {
      await clearConversation(from.id).catch(() => {});
      await ctx
        .editMessageText("<b>That entry expired</b> — start again with /ot.")
        .catch(() => ctx.reply("<b>That entry expired</b> — start again with /ot."));
      return;
    }
    const profile = await getProfile(from.id);
    if (!profile || !profile.salaryCents) {
      await clearConversation(from.id).catch(() => {});
      return ctx.reply(NO_SALARY);
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
    const text = `${otSavedText(saved)}\n\n📈 <b>${monthLabel(st.date!)} so far:</b> ${fmtHours(totals.paidHours)}h · ${fmtCents(totals.amountCents)}`;
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

  // ---- salary / goal amount entry (from the menu) ----
  if (st.flow === "salary" || st.flow === "goal") {
    const cents = parseSalaryToCents(text);
    if (cents === null || cents <= 0) {
      return ctx.reply("Send a valid amount, e.g. <b>470</b> or <b>470.50</b> (or /cancel).");
    }
    await clearConversation(from.id).catch(() => {});
    if (st.flow === "goal") {
      await setSavingGoal(from.id, cents).catch(() => {});
      return replySensitive(
        ctx,
        `🎯 <b>OT savings goal: ${fmtCents(cents)}</b>\n\nOT you log this month is paid on the 26th of next month — the goal tracks each month's payout. Record hours with /ot.`,
      );
    }
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
      return ctx.reply("I couldn't read that date.\nUse <b>YYYY-MM-DD</b> (e.g. 2026-08-15) or press Today.");
    }
    const next: OtState = { flow: "ot", step: "time", otType: st.otType, date };
    await setConversation(from.id, next).catch(() => {});
    return ctx.reply("🕐 <b>Start and finish time</b> (HH:MM)?\n\nFormat: <b>09:00-17:00</b>", {
      parse_mode: "HTML",
      reply_markup: cancelKeyboard(),
    });
  }

  if (st.step === "time") {
    const parsed = parseTimes(text);
    if (!parsed) {
      return ctx.reply("I couldn't read that. Use <b>HH:MM-HH:MM</b>, e.g. <b>09:00-17:00</b>.");
    }
    const profile = await getProfile(from.id);
    if (!profile || !profile.salaryCents) {
      await clearConversation(from.id).catch(() => {});
      return ctx.reply(NO_SALARY);
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