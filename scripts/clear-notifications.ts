// Clears payday-notification dedup marks so a reminder can be re-triggered
// (e.g. for testing a GitHub Actions run without TESTING=true).
//
// Usage:
//   npm run clear:marks            # clear today's marks only
//   npm run clear:marks -- all     # clear every mark

import { PrismaClient } from "@prisma/client";
import { todayInTz } from "../src/payday.js";

const TZ = process.env.APP_TZ || "Asia/Phnom_Penh";
const ALL = process.argv[2] === "all";

const prisma = new PrismaClient();

const result = ALL
  ? await prisma.notification.deleteMany({})
  : await prisma.notification.deleteMany({
      where: { eventKey: { contains: `:${todayInTz(TZ)}` } },
    });

console.log(
  ALL
    ? `Cleared ${result.count} notification mark(s).`
    : `Cleared ${result.count} mark(s) for ${todayInTz(TZ)}.`,
);

await prisma.$disconnect();

export {};