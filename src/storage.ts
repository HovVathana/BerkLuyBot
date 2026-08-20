import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import type { MonthTotals, OtRecord, OtState, OtType, Profile } from "./types.js";

const uid = (n: number): bigint => BigInt(n);

export interface ProfileFields {
  firstName: string | null;
  lastName: string | null;
  username: string | null;
}

async function getProfile(userId: number): Promise<Profile | null> {
  const row = await prisma.profile.findUnique({ where: { userId: uid(userId) } });
  if (!row) return null;
  return {
    userId: Number(row.userId),
    firstName: row.firstName,
    lastName: row.lastName,
    username: row.username,
    salaryCents: row.salaryCents,
    savingGoalCents: row.savingGoalCents,
    goalStartDate: row.goalStartDate,
  };
}

async function ensureProfile(userId: number, fields: ProfileFields): Promise<void> {
  await prisma.profile.upsert({
    where: { userId: uid(userId) },
    create: {
      userId: uid(userId),
      firstName: fields.firstName,
      lastName: fields.lastName,
      username: fields.username,
    },
    update: {
      firstName: fields.firstName,
      lastName: fields.lastName,
      username: fields.username,
    },
  });
}

async function setSalary(userId: number, salaryCents: number): Promise<void> {
  await prisma.profile.update({
    where: { userId: uid(userId) },
    data: { salaryCents },
  });
}

async function listProfilesWithSalary(): Promise<Profile[]> {
  const rows = await prisma.profile.findMany({
    where: { salaryCents: { not: null } },
  });
  return rows.map((r) => ({
    userId: Number(r.userId),
    firstName: r.firstName,
    lastName: r.lastName,
    username: r.username,
    salaryCents: r.salaryCents,
    savingGoalCents: r.savingGoalCents,
    goalStartDate: r.goalStartDate,
  }));
}

export interface SavingProgress {
  goalCents: number;
  earnedCents: number;
  count: number;
  startDate: string;
}

/** Sets the OT savings goal. The start date is recorded on first set. */
async function setSavingGoal(userId: number, goalCents: number, startDate: string): Promise<void> {
  const row = await prisma.profile.findUnique({ where: { userId: uid(userId) } });
  await prisma.profile.update({
    where: { userId: uid(userId) },
    data: {
      savingGoalCents: goalCents,
      goalStartDate: row?.goalStartDate ?? startDate,
    },
  });
}

async function clearSavingGoal(userId: number): Promise<void> {
  await prisma.profile.update({
    where: { userId: uid(userId) },
    data: { savingGoalCents: null, goalStartDate: null },
  });
}

/** OT money earned from the goal start date onwards, summed toward the goal. */
async function getSavingProgress(userId: number): Promise<SavingProgress | null> {
  const profile = await getProfile(userId);
  if (!profile || !profile.savingGoalCents || !profile.goalStartDate) return null;
  const agg = await prisma.otRecord.aggregate({
    where: {
      userId: uid(userId),
      date: { gte: profile.goalStartDate },
    },
    _sum: { amountCents: true },
    _count: true,
  });
  return {
    goalCents: profile.savingGoalCents,
    earnedCents: agg._sum.amountCents ?? 0,
    count: agg._count,
    startDate: profile.goalStartDate,
  };
}

export interface NewOtRecord {
  userId: number;
  date: string;
  startTime: string;
  endTime: string;
  otType: OtType;
  hours: number;
  breakHours: number;
  paidHours: number;
  rateCents: number;
  amountCents: number;
}

async function addOtRecord(rec: NewOtRecord): Promise<number> {
  const row = await prisma.otRecord.create({
    data: {
      userId: uid(rec.userId),
      date: rec.date,
      startTime: rec.startTime,
      endTime: rec.endTime,
      otType: rec.otType,
      hours: rec.hours,
      breakHours: rec.breakHours,
      paidHours: rec.paidHours,
      rateCents: rec.rateCents,
      amountCents: rec.amountCents,
    },
  });
  return row.id;
}

function mapOtRecord(r: {
  id: number;
  userId: bigint;
  date: string;
  startTime: string;
  endTime: string;
  otType: string;
  hours: number;
  breakHours: number;
  paidHours: number;
  rateCents: number;
  amountCents: number;
}): OtRecord {
  return {
    id: r.id,
    userId: Number(r.userId),
    date: r.date,
    startTime: r.startTime,
    endTime: r.endTime,
    otType: r.otType as OtType,
    hours: r.hours,
    breakHours: r.breakHours,
    paidHours: r.paidHours,
    rateCents: r.rateCents,
    amountCents: r.amountCents,
  };
}

function monthKeyOf(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

async function getOtRecords(userId: number, year: number, month: number): Promise<OtRecord[]> {
  const key = monthKeyOf(year, month);
  const rows = await prisma.otRecord.findMany({
    where: {
      userId: uid(userId),
      date: { gte: `${key}-01`, lte: `${key}-31` },
    },
    orderBy: [{ date: "asc" }, { id: "asc" }],
  });
  return rows.map(mapOtRecord);
}

async function getOtMonthTotals(userId: number, year: number, month: number): Promise<MonthTotals> {
  const records = await getOtRecords(userId, year, month);
  let paidHours = 0;
  let amountCents = 0;
  for (const r of records) {
    paidHours = Math.round((paidHours + r.paidHours) * 100) / 100;
    amountCents += r.amountCents;
  }
  return { count: records.length, paidHours, amountCents };
}

async function deleteOtRecord(userId: number, id: number): Promise<boolean> {
  const res = await prisma.otRecord.deleteMany({
    where: { id, userId: uid(userId) },
  });
  return res.count > 0;
}

async function getConversation(userId: number): Promise<OtState | null> {
  const row = await prisma.conversation.findUnique({ where: { userId: uid(userId) } });
  return row ? (row.state as unknown as OtState) : null;
}

async function setConversation(userId: number, state: OtState): Promise<void> {
  await prisma.conversation.upsert({
    where: { userId: uid(userId) },
    create: { userId: uid(userId), state: state as unknown as Prisma.InputJsonValue },
    update: { state: state as unknown as Prisma.InputJsonValue },
  });
}

async function clearConversation(userId: number): Promise<void> {
  await prisma.conversation.deleteMany({ where: { userId: uid(userId) } });
}

/** Returns true when the notification is new (not yet sent), false if duplicate. */
async function tryMarkNotification(
  userId: number,
  eventKey: string,
  kind: "reminder" | "payday",
): Promise<boolean> {
  try {
    await prisma.notification.create({
      data: { userId: uid(userId), eventKey, kind },
    });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return false; // duplicate (user_id, event_key, kind)
    }
    throw err;
  }
}

export {
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
  listProfilesWithSalary,
  setConversation,
  setSalary,
  setSavingGoal,
  tryMarkNotification,
};
export type { OtRecord };