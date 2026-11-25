import router from './oneToOneRoutes.js';
import { prisma } from './prisma.js';

function emitToConversation(io, conversationId, userIds, event, payload) {
  try {
    io?.to(`conversation:${conversationId}`).emit(event, payload);
    for (const id of userIds) if (id) io?.to(`user:${id}`).emit(event, payload);
  } catch (error) {
    console.error(`[one-to-one] ${event} broadcast failed:`, error?.message || error);
  }
}

export async function processOneToOneMaintenance(prismaClient = prisma, io = null) {
  const now = new Date();
  const due = await prismaClient.scheduledMessage.findMany({
    where: { status: 'pending', sendAt: { lte: now } },
    orderBy: { sendAt: 'asc' },
    take: 25,
    select: { id: true },
  });
  for (const item of due) {
    try {
      const result = await prismaClient.$transaction(async (tx) => {
        const claimed = await tx.scheduledMessage.updateMany({
          where: { id: item.id, status: 'pending', sendAt: { lte: now } },
          data: { status: 'sending' },
        });
        if (!claimed.count) return null;
        const job = await tx.scheduledMessage.findUnique({ where: { id: item.id } });
        const conversation = job && await tx.conversation.findUnique({ where: { id: job.conversationId } });
        if (!job || !conversation || (conversation.user1Id !== job.senderId && conversation.user2Id !== job.senderId)) {
          if (job) await tx.scheduledMessage.update({ where: { id: job.id }, data: { status: 'failed' } });
          return null;
        }
        const otherId = conversation.user1Id === job.senderId ? conversation.user2Id : conversation.user1Id;
        const blocked = await tx.blockedUser.findFirst({
          where: { OR: [{ blockerId: job.senderId, blockedId: otherId }, { blockerId: otherId, blockedId: job.senderId }] },
        });
        if (blocked) {
          await tx.scheduledMessage.update({ where: { id: job.id }, data: { status: 'failed' } });
          return null;
        }
        const sentAt = new Date();
        const expiresAt = conversation.disappearingSeconds
          ? new Date(sentAt.getTime() + conversation.disappearingSeconds * 1000)
          : null;
        const message = await tx.message.create({
          data: {
            content: job.content,
            kind: 'text',
            senderId: job.senderId,
            conversationId: job.conversationId,
            createdAt: sentAt,
            expiresAt,
          },
          include: {
            sender: { select: { id: true, username: true, displayName: true, avatar: true, avatarColor: true } },
          },
        });
        await tx.conversation.update({
          where: { id: job.conversationId },
          data: { lastMessage: job.content.slice(0, 100), lastMessageAt: sentAt, lastMessageBy: job.senderId },
        });
        await tx.scheduledMessage.update({
          where: { id: job.id },
          data: { status: 'sent', sentAt },
        });
        return {
          message,
          conversationId: job.conversationId,
          senderId: job.senderId,
          otherId,
          content: job.content,
        };
      });
      if (result) {
        emitToConversation(io, result.conversationId, [result.senderId, result.otherId], 'message:new', {
          message: result.message,
          conversationId: result.conversationId,
        });
        const { notifyNewMessage } = await import('./notifications.js');
        notifyNewMessage(prismaClient, io, {
          recipientId: result.otherId,
          senderId: result.senderId,
          senderName: result.message.sender?.displayName || result.message.sender?.username || 'Someone',
          content: result.content,
          conversationId: result.conversationId,
        }).catch(() => {});
      }
    } catch (error) {
      console.error('[one-to-one] scheduled send failed:', item.id, error?.message || error);
    }
  }

  const expired = await prismaClient.message.findMany({
    where: { conversationId: { not: null }, isDeleted: false, expiresAt: { lte: now } },
    take: 100,
    select: { id: true, conversationId: true, conversation: { select: { user1Id: true, user2Id: true } } },
  });
  for (const item of expired) {
    try {
      const removed = await prismaClient.message.deleteMany({
        where: { id: item.id, isDeleted: false, expiresAt: { lte: now } },
      });
      if (removed.count) {
        emitToConversation(io, item.conversationId, [item.conversation.user1Id, item.conversation.user2Id], 'message:deleted', {
          messageId: item.id,
          scope: 'everyone',
          expired: true,
        });
      }
    } catch (error) {
      console.error('[one-to-one] expire message failed:', item.id, error?.message || error);
    }
  }

  const expiredShares = await prismaClient.liveLocationShare.findMany({
    where: { stoppedAt: null, expiresAt: { lte: now } },
    take: 100,
    select: { id: true, conversationId: true, conversation: { select: { user1Id: true, user2Id: true } } },
  });
  for (const share of expiredShares) {
    try {
      const stopped = await prismaClient.liveLocationShare.updateMany({
        where: { id: share.id, stoppedAt: null, expiresAt: { lte: now } },
        data: { stoppedAt: now },
      });
      if (stopped.count) {
        emitToConversation(io, share.conversationId, [share.conversation.user1Id, share.conversation.user2Id], 'location-share:stopped', {
          shareId: share.id,
          conversationId: share.conversationId,
          expired: true,
        });
      }
    } catch (error) {
      console.error('[one-to-one] expire location share failed:', share.id, error?.message || error);
    }
  }
}

export function startOneToOneMaintenance(io) {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await processOneToOneMaintenance(prisma, io);
    } catch (error) {
      console.error('[one-to-one] maintenance failed:', error?.message || error);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(run, 5000);
  timer.unref?.();
  void run();
  return timer;
}

export { initOneToOneCallHandler } from './callSignals.js';

export default router;
