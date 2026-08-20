# Telegram Salary & OT Tracking Bot

A private, per-user Telegram bot that tracks monthly salary, records overtime (OT),
calculates OT pay, and notifies users when payday is approaching.

- **Node.js + TypeScript**, webhook-deployed on **Vercel** (free tier)
- **Supabase** (Postgres) for storage — each Telegram account gets its own row: nobody
  can ever see someone else's salary or OT
- **Payday nudges are free:** a GitHub Actions cron (or Vercel Cron) calls a protected
  `/api/payday` endpoint every day

## Features

| Command | What it does |
| --- | --- |
| `/start`, `/help` | Intro + list of commands |
| `/setsalary 470` | Set (or edit) monthly salary |
| `/salary` | Salary, base hourly rate, OT rates |
| `/ot` | Guided OT entry — or quick form `/ot A 09:00-17:00`, `/ot D 2026-01-01 09:00-17:00` |
| `/otlist [YYYY-MM]` | OT records for a month with totals |
| `/month [YYYY-MM]` | Salary + OT summary, both paydays, expected total |
| `/payday` | Next payday(s): scheduled date, actual date, salary part, OT part, total |
| `/del <id>` | Delete an OT record (find ids with `/otlist`) |
| `/cancel` | Cancel the current OT entry |

**Privacy in groups:** the bot replies in the group with generic prompts only. Anything
sensitive (salary, OT amounts, paydays) is always sent as a private message to the user.

## OT rules (implemented exactly)

```
base hourly   = (monthly salary × 12) / (40 × 52)        (full precision)
OT rate       = ROUND(base hourly × factor, 2)           (rounded once, at the end)
D (holiday)   = factor 1.0    e.g. $500 salary → $2.88/h
N (evening)   = factor 1.5    e.g. $500 salary → $4.33/h
A (weekend)   = factor 2.0    e.g. $500 salary → $5.77/h
OT pay        = paid OT hours × OT rate   (final amount rounded to 2dp)
```

The rate is never computed from an already-rounded base (that would wrongly give
$4.32/$5.76 for $500). **Nothing is hardcoded** — rates are recalculated from the
user's salary whenever it changes, and every stored OT record carries its own
`rate_cents`/`amount_cents`, so historical OT never changes after a salary edit.

Break rule: a session of **≥ 6 hours** (a "full day") deducts **1 hour** break
(`FULL_DAY_MIN_HOURS` / `BREAK_HOURS` in `src/payroll.ts`); shorter/evening sessions
get no break. 09:00–17:00 → 7 paid hours; 16:30–18:30 → 2 paid hours.

Everything is computed in integer **cents**; "round to 2dp" = `Math.round` (half up).

## Payday rules (implemented exactly)

- Paydays: **12th** = salary ÷ 2. **26th** = other salary half + that month's OT (OT is
  never included in the 12th).
- If the 12th/26th falls on a **weekend or public holiday**, it moves **backward** to the
  previous working day (26th on Sunday → Friday 24th).
- Public holidays live in `src/holidays.ts` — **verify and complete the list for your
  country's official calendar** (the file ships with a few fixed-date samples only).
  The `TZ` env var decides what "today" is.

## Architecture

```
Telegram ──► /api/webhook (Vercel function) ──► grammY handlers ──► Prisma ──► Supabase Postgres
GitHub Actions cron (free) ──► /api/payday (Vercel function) ──► send payday nudges
```

- `api/webhook.ts` — receives Telegram updates
- `api/payday.ts` — payday reminder/nudge job (protected by `CRON_SECRET`)
- `src/bot.ts` — all commands + guided `/ot` conversation (state kept in the database, so
  it survives serverless cold starts)
- `src/payroll.ts` — money/time math · `src/payday.ts` — dates/payday adjustment
- `src/storage.ts` — Prisma queries · `src/messages.ts` — message text builders
- `prisma/schema.prisma` — the single source of truth for the schema; migrations in
  `prisma/migrations/` are applied with `prisma migrate deploy`

## Setup

### 1. Create the Telegram bot

Talk to [@BotFather](https://t.me/BotFather): `/newbot` → copy the token.

### 2. Create a Supabase project & the database tables

1. Create a project at [supabase.com](https://supabase.com) (note the database password
   you set — or reset it later in Project Settings → Database → Reset password).
2. Get the **connection strings**: Project Settings → Database → **Connection string**
   (or the dashboard's "Connect → ORMs → Prisma" view):
   - **Transaction pooler** (`...pooler.supabase.com:6543/postgres`) →
     `DATABASE_URL` (used by the serverless functions)
   - **Direct** / Session (`...pooler.supabase.com:5432/postgres`) →
     `DATABASE_URL_DIRECT` (used by Prisma Migrate)
3. Apply the checked-in migration to create the tables:

   ```bash
   cp .env.example .env   # fill in the two DATABASE_URL values
   npm install
   npm run db:deploy      # prisma migrate deploy
   ```

   > If you previously ran the old hand-written SQL from an earlier version of
   > this project, drop those tables first (or run `npm run db:reset`) so Prisma
   > can own the schema.

### 3. Deploy to Vercel

```bash
npm install
vercel deploy --prod
```

Set these **Environment Variables** in the Vercel project (Settings → Environment Variables):

| Variable | Example |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | `123456789:AA...` |
| `DATABASE_URL` | `postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1` |
| `DATABASE_URL_DIRECT` | `postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres` |
| `CRON_SECRET` | any long random string |
| `TZ` | `Asia/Phnom_Penh` (default) |
| `REMIND_DAYS_BEFORE` | `3` (default) |
| `TELEGRAM_SECRET_TOKEN` | optional webhook lock |

`npm install` runs `prisma generate` automatically (see `postinstall`), so Vercel's build
generates the client with the right Prisma engines for its runtime.

### 4. Point Telegram at the webhook

After the Vercel deployment is live:

```bash
TELEGRAM_BOT_TOKEN=... npm run webhook:set -- https://your-app.vercel.app/api/webhook
```

Verify with `getWebhookInfo`:
`curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"`.

### 5. Free payday nudges

Pick one (both are free):

**GitHub Actions (required setup shown in `.github/workflows/payday.yml`):**
1. Create the workflow in this repo (already included).
2. Set repo **Secrets** → `PAYDAY_CRON_SECRET` (same value as Vercel's `CRON_SECRET`).
3. Set repo **Variables** → `VERCEL_DEPLOY_URL` (e.g. `https://your-app.vercel.app`).
4. It runs daily at 01:00 UTC (08:00 UTC+7) — adjust `cron:` in the YAML to match `TZ`.

**Vercel Cron (alternative):** `vercel.json` already defines a cron for `/api/payday`;
Vercel will send `Authorization: Bearer $CRON_SECRET` automatically. Remove the `crons`
block from `vercel.json` if you use GitHub Actions instead.

The nudge will remind a user when the next **actual** payday is within
`REMIND_DAYS_BEFORE` days, and send a "Payday is TODAY 💰" message with the breakdown
(scheduled date, actual date, salary half, OT amount, total) on the day itself.
Notifications are deduplicated in the database.

## Local development

```bash
vercel dev          # local webhook + environment (add .env with the vars above)
npm run typecheck   # tsc --noEmit
npm test            # verifies the OT formula + payday rules against the spec examples
```

## Notes

- Money is all integer cents — no floating point drift.
- `FULL_DAY_MIN_HOURS` (default 6) decides when the 1-hour break applies; change it in
  `src/payroll.ts` if your rules differ.
- Currency formatting is `$`; adjust `fmtCents` in `src/format.ts` if needed.
- Holiday dates must be maintained per year in `src/holidays.ts`.
- **Serverless pooling:** the bot runs on Vercel functions, so it uses Supabase's
  transaction pooler (`?pgbouncer=true&connection_limit=1`); `prisma migrate deploy`
  uses the direct connection. After changing `prisma/schema.prisma`, create a new
  migration locally with `npx prisma migrate dev --name <name>` and deploy it with
  `npm run db:deploy`.