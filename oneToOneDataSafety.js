import { prisma } from './prisma.js';

const INTERVAL_MS = 60_000;

export async function processOneToOneDataSafety(prismaClient = prisma, now = new Date()) {
  // Rebuild direct-conversation previews from messages that are still visible.
  // This repairs previews left behind by undo-send and disappearing messages.
  await prismaClient.$executeRaw`
    UPDATE "Conversation" AS c
    SET "lastMessage" = LEFT(latest."content", 100),
        "lastMessageAt" = latest."createdAt",
        "lastMessageBy" = latest."senderId"
    FROM (
      SELECT DISTINCT ON (m."conversationId")
        m."conversationId", m."content", m."createdAt", m."senderId"
      FROM "Message" AS m
      WHERE m."conversationId" IS NOT NULL
        AND m."isDeleted" = false
        AND (m."expiresAt" IS NULL OR m."expiresAt" > ${now})
      ORDER BY m."conversationId", m."createdAt" DESC, m."id" DESC
    ) AS latest
    WHERE c."id" = latest."conversationId"
      AND (
        c."lastMessage" IS DISTINCT FROM LEFT(latest."content", 100)
        OR c."lastMessageAt" IS DISTINCT FROM latest."createdAt"
        OR c."lastMessageBy" IS DISTINCT FROM latest."senderId"
      )
  `;

  // Clear a preview when no non-deleted, non-expired direct message remains.
  await prismaClient.$executeRaw`
    UPDATE "Conversation" AS c
    SET "lastMessage" = NULL,
        "lastMessageAt" = NULL,
        "lastMessageBy" = NULL
    WHERE (c."lastMessage" IS NOT NULL OR c."lastMessageAt" IS NOT NULL OR c."lastMessageBy" IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1
        FROM "Message" AS m
        WHERE m."conversationId" = c."id"
          AND m."isDeleted" = false
          AND (m."expiresAt" IS NULL OR m."expiresAt" > ${now})
      )
  `;

  // Stopped or expired shares are no longer needed by active-share endpoints.
  // Keep a short grace period for expiry event delivery, then erase coordinates.
  const retentionCutoff = new Date(now.getTime() - INTERVAL_MS);
  await prismaClient.liveLocationShare.deleteMany({
    where: {
      OR: [
        { stoppedAt: { not: null } },
        { expiresAt: { lte: retentionCutoff } },
      ],
    },
  });
}

export function startOneToOneDataSafety(prismaClient = prisma) {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await processOneToOneDataSafety(prismaClient);
    } catch (error) {
      console.error('[one-to-one] data-safety maintenance failed:', error?.message || error);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(run, INTERVAL_MS);
  timer.unref?.();
  return timer;
}
