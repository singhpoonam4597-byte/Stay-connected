import { rateLimit } from './scale.js';
import { prisma } from './prisma.js';

function emitToConversation(io, conversationId, userIds, event, payload) {
  try {
    io?.to(`conversation:${conversationId}`).emit(event, payload);
    for (const id of userIds) if (id) io?.to(`user:${id}`).emit(event, payload);
  } catch (error) {
    console.error(`[one-to-one] ${event} broadcast failed:`, error?.message || error);
  }
}

/** Persist one call-history message per callId (idempotent). */
async function recordCallHistory(prismaClient, io, {
  callId,
  conversationId,
  actorUserId,
  peerId,
  mediaType,
  status,
  durationMs = 0,
  directionForActor = 'out',
}) {
  if (!callId || !conversationId || !actorUserId) return null;
  const marker = `callId:${callId}`;
  try {
    const existing = await prismaClient.message.findFirst({
      where: {
        conversationId,
        kind: 'call',
        content: { contains: marker },
      },
      select: { id: true },
    });
    if (existing) return null;

    const durationSeconds = Math.max(0, Math.floor(Number(durationMs) / 1000) || 0);
    const safeMedia = mediaType === 'video' ? 'video' : 'audio';
    const safeStatus = ['completed', 'missed', 'declined', 'unanswered', 'no_answer'].includes(status)
      ? status
      : durationSeconds > 0
        ? 'completed'
        : 'unanswered';

    const meta = {
      v: 1,
      callId,
      mediaType: safeMedia,
      status: safeStatus === 'no_answer' ? 'unanswered' : safeStatus,
      durationSeconds,
      direction: directionForActor === 'in' ? 'in' : 'out',
    };
    const content = JSON.stringify(meta);

    const preview =
      safeStatus === 'declined'
        ? safeMedia === 'video'
          ? 'Declined video call'
          : 'Declined voice call'
        : safeStatus === 'missed' || safeStatus === 'unanswered'
          ? safeMedia === 'video'
            ? 'Missed video call'
            : 'Missed voice call'
          : durationSeconds > 0
            ? safeMedia === 'video'
              ? `Video call · ${Math.floor(durationSeconds / 60)}:${String(durationSeconds % 60).padStart(2, '0')}`
              : `Voice call · ${Math.floor(durationSeconds / 60)}:${String(durationSeconds % 60).padStart(2, '0')}`
            : safeMedia === 'video'
              ? 'Video call'
              : 'Voice call';

    const now = new Date();
    const message = await prismaClient.message.create({
      data: {
        content: `${content}\n${marker}`,
        kind: 'call',
        senderId: actorUserId,
        conversationId,
        createdAt: now,
      },
      include: {
        sender: {
          select: { id: true, username: true, displayName: true, avatar: true, avatarColor: true },
        },
        reactions: true,
        attachments: true,
      },
    });

    await prismaClient.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessage: preview.slice(0, 100),
        lastMessageAt: now,
        lastMessageBy: actorUserId,
      },
    });

    const safeMessage = {
      ...message,
      callMeta: meta,
      isStarredByMe: false,
      attachments: [],
    };

    emitToConversation(io, conversationId, [actorUserId, peerId], 'message:new', {
      message: safeMessage,
      conversationId,
    });
    return safeMessage;
  } catch (error) {
    console.error('[one-to-one] record call history:', error?.message || error);
    return null;
  }
}

export function initOneToOneCallHandler(io, prismaClient = prisma) {
  const callEvents = [
    'call:invite',
    'call:offer',
    'call:answer',
    'call:ice',
    'call:decline',
    'call:end',
    'call:ringing',
    'call:media-upgrade',
  ];
  io.on('connection', (socket) => {
    const userId = socket.userId;
    const relay = async (eventName, data = {}) => {
      try {
        const callId = String(data?.callId || '');
        const conversationId = String(data?.conversationId || '');
        if (!userId || !callId || callId.length > 128 || !conversationId || conversationId.length > 128) {
          return socket.emit('call:error', { callId, message: 'Invalid call signal' });
        }
        if (JSON.stringify(data).length > 120000) {
          return socket.emit('call:error', { callId, message: 'Call signal is too large' });
        }
        const limit = rateLimit(`call-signal:${userId}`, { limit: 120, windowMs: 60000 });
        if (!limit.ok) return socket.emit('call:error', { callId, message: 'Too many call signals' });
        const conversation = await prismaClient.conversation.findUnique({
          where: { id: conversationId },
          select: { user1Id: true, user2Id: true },
        });
        if (!conversation || (conversation.user1Id !== userId && conversation.user2Id !== userId)) {
          return socket.emit('call:error', { callId, message: 'No access to this conversation' });
        }
        const peerId = conversation.user1Id === userId ? conversation.user2Id : conversation.user1Id;
        const blocked = await prismaClient.blockedUser.findFirst({
          where: { OR: [{ blockerId: userId, blockedId: peerId }, { blockerId: peerId, blockedId: userId }] },
        });
        if (blocked) return socket.emit('call:error', { callId, message: 'Calls are unavailable in this conversation' });
        const payload = { callId, conversationId, fromUserId: userId };
        if (eventName === 'call:invite') {
          if (!['audio', 'video'].includes(data.mediaType)) {
            return socket.emit('call:error', { callId, message: 'Invalid call type' });
          }
          payload.mediaType = data.mediaType;
          try {
            const me = await prismaClient.user.findUnique({
              where: { id: userId },
              select: { displayName: true, username: true },
            });
            payload.callerName = me?.displayName || me?.username || socket.username || 'Contact';
          } catch (_) {
            payload.callerName = socket.username || 'Contact';
          }
        } else if (eventName === 'call:offer' || eventName === 'call:answer') {
          const expectedType = eventName === 'call:offer' ? 'offer' : 'answer';
          if (
            !data.description ||
            data.description.type !== expectedType ||
            typeof data.description.sdp !== 'string' ||
            data.description.sdp.length > 100000
          ) {
            return socket.emit('call:error', { callId, message: 'Invalid call description' });
          }
          payload.description = data.description;
        } else if (eventName === 'call:ice') {
          if (
            !data.candidate ||
            typeof data.candidate !== 'object' ||
            JSON.stringify(data.candidate).length > 10000
          ) {
            return socket.emit('call:error', { callId, message: 'Invalid network candidate' });
          }
          payload.candidate = data.candidate;
        } else if (eventName === 'call:ringing') {
          // acknowledgement only
        } else if (eventName === 'call:media-upgrade') {
          if (data.mediaType === 'video') payload.mediaType = 'video';
        }

        io.to(`user:${peerId}`).emit(eventName, payload);

        if (eventName === 'call:decline' || eventName === 'call:end') {
          const mediaType = data.mediaType === 'video' ? 'video' : 'audio';
          const durationMs = Number(data.durationMs) || 0;
          let status = 'unanswered';
          if (eventName === 'call:decline') {
            status = 'declined';
          } else if (durationMs > 0 || data.status === 'connected') {
            status = 'completed';
          } else if (data.status === 'ringing' || data.status === 'calling') {
            status = 'unanswered';
          } else {
            status = 'missed';
          }

          const directionForActor =
            eventName === 'call:decline'
              ? 'in'
              : data.direction === 'in'
                ? 'in'
                : 'out';

          await recordCallHistory(prismaClient, io, {
            callId,
            conversationId,
            actorUserId: userId,
            peerId,
            mediaType,
            status,
            durationMs,
            directionForActor,
          });
        }
      } catch (error) {
        console.error('[one-to-one] call signal:', error?.message || error);
        socket.emit('call:error', {
          callId: String(data?.callId || ''),
          message: 'Could not deliver call signal',
        });
      }
    };
    for (const eventName of callEvents) {
      socket.on(eventName, (data) => {
        void relay(eventName, data);
      });
    }
  });
}
