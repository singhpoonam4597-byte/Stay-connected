import express from 'express';
import { prisma } from './server.js';
import { authenticateToken } from './jwt.js';

const router = express.Router();

const userPublicSelect = {
  id: true,
  username: true,
  displayName: true,
  avatar: true,
  avatarColor: true,
  isOnline: true,
};

async function requireConversationAccess(req, res, next) {
  try {
    const currentUserId = req.user?.id || req.userId;
    const { conversationId } = req.params;
    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found', code: 'NOT_FOUND' });
    }
    if (conversation.user1Id !== currentUserId && conversation.user2Id !== currentUserId) {
      return res.status(403).json({ error: 'No access to this conversation', code: 'NO_ACCESS' });
    }
    req.conversation = conversation;
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Access check failed' });
  }
}

function serializeMessage(m) {
  if (!m) return m;
  const out = { ...m };
  if (Array.isArray(out.attachments)) {
    out.attachments = out.attachments.map((a) => ({
      ...a,
      fileSize: typeof a.fileSize === 'bigint' ? Number(a.fileSize) : a.fileSize,
    }));
  }
  return out;
}

router.post('/', authenticateToken, async (req, res) => {
  try {
    const currentUserId = req.user?.id || req.userId;
    const otherUserId =
      req.body?.otherUserId || req.body?.userId || req.body?.participantId ||
      req.body?.receiverId || req.body?.targetUserId || req.body?.toUserId;
    if (!otherUserId) {
      return res.status(400).json({ error: 'Other user ID is required', code: 'MISSING_USER_ID' });
    }
    if (currentUserId === otherUserId) {
      return res.status(400).json({ error: 'You cannot create a conversation with yourself', code: 'SELF_CONVERSATION' });
    }
    const otherUser = await prisma.user.findUnique({ where: { id: otherUserId }, select: { id: true } });
    if (!otherUser) {
      return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
    }
    const blocked = await prisma.blockedUser.findFirst({
      where: {
        OR: [
          { blockerId: currentUserId, blockedId: otherUserId },
          { blockerId: otherUserId, blockedId: currentUserId },
        ],
      },
    });
    if (blocked) {
      return res.status(403).json({ error: 'You cannot message this user', code: 'USER_BLOCKED' });
    }
    let conversation = await prisma.conversation.findFirst({
      where: {
        OR: [
          { user1Id: currentUserId, user2Id: otherUserId },
          { user1Id: otherUserId, user2Id: currentUserId },
        ],
      },
      include: {
        user1: { select: userPublicSelect },
        user2: { select: userPublicSelect },
        _count: { select: { messages: true } },
      },
    });
    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: { user1Id: currentUserId, user2Id: otherUserId },
        include: {
          user1: { select: userPublicSelect },
          user2: { select: userPublicSelect },
          _count: { select: { messages: true } },
        },
      });
    }
    res.status(201).json({ success: true, data: { conversation } });
  } catch (error) {
    console.error('Create conversation error:', error);
    res.status(500).json({ error: 'Failed to create conversation', code: 'CREATE_ERROR' });
  }
});

router.get('/', authenticateToken, async (req, res) => {
  try {
    const currentUserId = req.user?.id || req.userId;
    const { limit = 50, offset = 0 } = req.query;
    const take = Math.min(parseInt(limit) || 50, 100);
    const skip = Math.max(parseInt(offset) || 0, 0);

    const blockedRows = await prisma.blockedUser.findMany({
      where: {
        OR: [{ blockerId: currentUserId }, { blockedId: currentUserId }],
      },
      select: { blockerId: true, blockedId: true },
    });
    const blockedIds = new Set();
    for (const r of blockedRows) {
      if (r.blockerId !== currentUserId) blockedIds.add(r.blockerId);
      if (r.blockedId !== currentUserId) blockedIds.add(r.blockedId);
    }

    let conversations = await prisma.conversation.findMany({
      where: { OR: [{ user1Id: currentUserId }, { user2Id: currentUserId }] },
      include: {
        user1: { select: userPublicSelect },
        user2: { select: userPublicSelect },
        _count: { select: { messages: true } },
      },
      orderBy: { lastMessageAt: 'desc' },
      take: take + blockedIds.size,
      skip,
    });
    conversations = conversations
      .filter((c) => {
        const other = c.user1Id === currentUserId ? c.user2Id : c.user1Id;
        return !blockedIds.has(other);
      })
      .slice(0, take);

    const total = conversations.length;
    const withUnread = await Promise.all(
      conversations.map(async (c) => {
        const isUser1 = c.user1Id === currentUserId;
        const lastReadAt = isUser1 ? c.user1LastReadAt : c.user2LastReadAt;
        const unreadCount = await prisma.message.count({
          where: {
            conversationId: c.id,
            isDeleted: false,
            senderId: { not: currentUserId },
            ...(lastReadAt ? { createdAt: { gt: lastReadAt } } : {}),
          },
        });
        return { ...c, unreadCount };
      })
    );
    res.status(200).json({ success: true, data: { conversations: withUnread, total, limit: take, offset: skip } });
  } catch (error) {
    console.error('Get conversations error:', error);
    res.status(500).json({ error: 'Failed to fetch conversations', code: 'FETCH_ERROR' });
  }
});

router.post('/:conversationId/read', authenticateToken, requireConversationAccess, async (req, res) => {
  try {
    const currentUserId = req.user?.id || req.userId;
    const { conversationId } = req.params;
    const conversation = req.conversation;
    const now = new Date();
    const data = conversation.user1Id === currentUserId ? { user1LastReadAt: now } : { user2LastReadAt: now };
    await prisma.conversation.update({ where: { id: conversationId }, data });
    const io = req.app.get('io');
    if (io) {
      io.to(`conversation:${conversationId}`).emit('conversation:read', {
        conversationId,
        userId: currentUserId,
        readAt: now.toISOString(),
      });
    }
    res.status(200).json({ success: true, data: { conversationId, readAt: now.toISOString() } });
  } catch (error) {
    console.error('Mark conversation read error:', error);
    res.status(500).json({ error: 'Failed to mark as read', code: 'READ_ERROR' });
  }
});

router.get('/:conversationId/messages', authenticateToken, requireConversationAccess, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { limit = 50, offset = 0 } = req.query;
    const take = Math.min(parseInt(limit, 10) || 50, 100);
    const skip = Math.max(parseInt(offset, 10) || 0, 0);

    let messages;
    try {
      messages = await prisma.message.findMany({
        where: { conversationId, isDeleted: false },
        include: {
          sender: {
            select: { id: true, username: true, displayName: true, avatar: true, avatarColor: true },
          },
          replyTo: {
            select: {
              id: true,
              content: true,
              isDeleted: true,
              sender: { select: { displayName: true } },
            },
          },
          reactions: { select: { id: true, emoji: true, userId: true } },
          attachments: true,
        },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      });
    } catch (includeErr) {
      console.error('Messages include query failed, fallback:', includeErr?.message);
      messages = await prisma.message.findMany({
        where: { conversationId, isDeleted: false },
        include: {
          sender: { select: { id: true, username: true, displayName: true, avatar: true } },
        },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      });
    }

    try {
      const currentUserId = req.user?.id || req.userId;
      const conv = req.conversation;
      if (conv && currentUserId) {
        const now = new Date();
        const data = conv.user1Id === currentUserId ? { user1LastReadAt: now } : { user2LastReadAt: now };
        await prisma.conversation.update({ where: { id: conversationId }, data });
        const io = req.app.get('io');
        if (io) {
          io.to(`conversation:${conversationId}`).emit('conversation:read', {
            conversationId,
            userId: currentUserId,
            readAt: now.toISOString(),
          });
        }
      }
    } catch (e) {
      console.error('Auto mark read failed', e);
    }

    const total = await prisma.message.count({ where: { conversationId, isDeleted: false } });
    res.status(200).json({
      success: true,
      data: {
        messages: messages.reverse().map(serializeMessage),
        total,
        limit: take,
        offset: skip,
      },
    });
  } catch (error) {
    console.error('Get conversation messages error:', error);
    res.status(500).json({
      error: 'Failed to fetch messages',
      code: 'FETCH_ERROR',
      detail: String(error?.message || error),
    });
  }
});

router.delete('/:conversationId/messages', authenticateToken, requireConversationAccess, async (req, res) => {
  try {
    const { conversationId } = req.params;
    await prisma.message.updateMany({
      where: { conversationId, isDeleted: false },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        content: '',
      },
    });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessage: null,
        lastMessageAt: null,
        lastMessageBy: null,
      },
    });
    const io = req.app.get('io');
    if (io) {
      io.to(`conversation:${conversationId}`).emit('conversation:cleared', {
        conversationId,
      });
    }
    res.status(200).json({ success: true, data: { conversationId } });
  } catch (error) {
    console.error('Clear conversation messages error:', error);
    res.status(500).json({ error: 'Failed to clear chat', code: 'CLEAR_ERROR' });
  }
});

router.get('/:conversationId', authenticateToken, requireConversationAccess, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        user1: { select: userPublicSelect },
        user2: { select: userPublicSelect },
        _count: { select: { messages: true } },
      },
    });
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found', code: 'NOT_FOUND' });
    }
    res.status(200).json({ success: true, data: { conversation } });
  } catch (error) {
    console.error('Get conversation error:', error);
    res.status(500).json({ error: 'Failed to fetch conversation', code: 'FETCH_ERROR' });
  }
});

router.delete('/:conversationId', authenticateToken, requireConversationAccess, async (req, res) => {
  try {
    const { conversationId } = req.params;
    await prisma.conversation.delete({ where: { id: conversationId } });
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Delete conversation error:', error);
    res.status(500).json({ error: 'Failed to delete conversation', code: 'DELETE_ERROR' });
  }
});

router.get('/:conversationId/search', authenticateToken, requireConversationAccess, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const q = String(req.query.q || '').trim();
    if (!q) {
      return res.status(400).json({ error: 'Query is required', code: 'MISSING_QUERY' });
    }
    const messages = await prisma.message.findMany({
      where: {
        conversationId,
        isDeleted: false,
        content: { contains: q, mode: 'insensitive' },
      },
      include: {
        sender: {
          select: { id: true, username: true, displayName: true, avatar: true, avatarColor: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.status(200).json({ success: true, data: { messages, count: messages.length } });
  } catch (error) {
    console.error('Search messages error:', error);
    res.status(500).json({ error: 'Failed to search messages', code: 'SEARCH_ERROR' });
  }
});

export default router;
