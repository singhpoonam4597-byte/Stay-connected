import { PrismaClient } from '@prisma/client';

/**
 * Single shared Prisma client for the whole process.
 * On Neon, set DATABASE_URL to the *pooled* connection string
 * (host contains -pooler) so hundreds of concurrent chats don't
 * exhaust Postgres connections.
 */
const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.__connectPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__connectPrisma = prisma;
}

export default prisma;
