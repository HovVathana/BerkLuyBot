import { PrismaClient } from "@prisma/client";

// Reuse a single PrismaClient across serverless invocations (Vercel keeps the
// module warm between requests; never opening more connections than needed).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();
export default prisma;

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}