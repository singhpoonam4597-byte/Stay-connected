import express from 'express';
import { prisma } from './prisma.js';
import { authenticateToken, requireConversationAccess } from './auth.js';

const router = express.Router();

async function attachUnreadCounts(conversations, currentUserId) {
  if (!conversations?.length) return conversations || [];
  const out = [];
  for (const c of conversations) {
    try {
      const isUser1 = c.user1Id === currentUserId;
      const lastRead = isUser1 ? c.user1LastReadAt : c.user2LastReadAt;
      const where = {
        conversationId: c.id,
        isDeleted: false,
        senderId: { not: currentUserId },
      };
      if (lastRead) where.createdAt = { gt: lastRead };
      const unreadCount = await prisma.message.count({ where });
      out.push({ ...c, unreadCount });
    } catch (e) {
      out.push({ ...c, unreadCount: 0 });
    }
  }
  return out;
}

const userSelect = {
  id: true, username: true, displayName: true, avatar: true, avatarColor: true,
  isOnline: true, lastSeen: true,
};

router.post('/', authenticateToken, async (req, res) => {
  try {
    const currentUserId = req.userId;
    const { otherUserId } = req.body;
    if (!otherUserId) {
      return res.status(400).json({ error: 'Other user ID is required', code: 'MISSING_USER_ID' });
    }
    if (currentUserId === otherUserId) {
      return res.status(400).json({ error: 'You cannot create a conversation with yourself', code: 'SELF_CONVERSATION' });
    }
    const otherUser = await prisma.user.findUnique({
      where: { id: otherUserId },
      select: { id: true, username: true, displayName: true, avatar: true, avatarColor: true },
    });
    if (!otherUser) {
      return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
    }
    try {
      const blocked = await prisma.blockedUser.findFirst({
        where: {
          OR: [
            { blockerId: currentUserId, blockedId: otherUserId },
            { blockerId: otherUserId, blockedId: currentUserId },
          ],
        },
      });
      if (blocked) {
        return res.status(403).json({ error: 'Cannot message this user', code: 'BLOCKED' });
      }
    } catch (_) {}

    try {
      const targetSettings = await prisma.userSettings.findUnique({
        where: { userId: otherUserId },
        select: { allowUnknownMessages: true },
      });
      if (targetSettings && targetSettings.allowUnknownMessages === false) {
        const [a, b] =
          currentUserId < otherUserId
            ? [currentUserId, otherUserId]
            : [otherUserId, currentUserId];
        const existing = await prisma.conversation.findFirst({
          where: { user1Id: a, user2Id: b },
          select: { id: true },
        });
        if (!existing) {
          return res.status(403).json({
            error: 'This user only accepts messages from people they know',
            code: 'UNKNOWN_MESSAGES_BLOCKED',
          });
        }
      }
    } catch (e) {
      console.warn('allowUnknownMessages check', e?.message);
    }

    const [u1, u2] =
      currentUserId < otherUserId ? [currentUserId, otherUserId] : [otherUserId, currentUserId];
    let conversation = await prisma.conversation.findFirst({
      where: { user1Id: u1, user2Id: u2 },
      include: { user1: { select: userSelect }, user2: { select: userSelect } },
    });
    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: { user1Id: u1, user2Id: u2 },
        include: { user1: { select: userSelect }, user2: { select: userSelect } },
      });
    }
    res.status(200).json({ success: true, data: { conversation } });
  } catch (error) {
    console.error('Create conversation error:', error);
    res.status(500).json({ error: 'Failed to create conversation', code: 'CREATE_CONVERSATION_ERROR' });
  }
});

router.get('/', authenticateToken, async (req, res) => {
  try {
    const currentUserId = req.userId;
    let conversations = await prisma.conversation.findMany({
      where: {
        OR: [
          { user1Id: currentUserId, user1ArchivedAt: null },
          { user2Id: currentUserId, user2ArchivedAt: null },
        ],
      },
      include: { user1: { select: userSelect }, user2: { select: userSelect } },
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
    });
    conversations = await attachUnreadCounts(conversations, currentUserId);
    res.status(200).json({ success: true, data: { conversations } });
  } catch (error) {
    console.error('List conversations error:', error);
    res.status(500).json({ error: 'Failed to list conversations', code: 'LIST_ERROR' });
  }
});

router.get('/:conversationId/messages', authenticateToken, requireConversationAccess, async (req, res) => {
  const { conversationId } = req.params;
  const limit = Math.min(parseInt(String(req.query.limit || '80'), 10) || 80, 100);
  const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);
  const currentUserId = req.userId;
  try {
    let rows = await prisma.message.findMany({
      where: { conversationId, isDeleted: false },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
    rows = rows.reverse();
    const messages = rows.map((m) => ({ ...m, attachments: [] }));
    try {
      const msgIds = rows.map((m) => m.id);
      if (msgIds.length) {
        const atts = await prisma.attachment.findMany({ where: { messageId: { in: msgIds } } });
        const attMap = {};
        for (const a of atts || []) {
          if (!attMap[a.messageId]) attMap[a.messageId] = [];
          attMap[a.messageId].push({
            ...a,
            fileSize: typeof a.fileSize === 'bigint' ? Number(a.fileSize) : a.fileSize,
          });
        }
        for (const m of messages) m.attachments = attMap[m.id] || [];
      }
    } catch (_) {}
    res.status(200).json({ success: true, data: { messages, total: messages.length, limit, offset } });
  } catch (error) {
    console.error('[messages]', error?.message || error);
    res.status(200).json({ success: true, data: { messages: [], total: 0, limit, offset } });
  }
});

router.get('/:conversationId', authenticateToken, requireConversationAccess, async (req, res) => {
  try {
    const currentUserId = req.userId || req.user?.id;
    let conversation = await prisma.conversation.findUnique({
      where: { id: req.params.conversationId },
      include: { user1: { select: userSelect }, user2: { select: userSelect } },
    });
    try {
      if (conversation) {
        for (const key of ['user1', 'user2']) {
          const peer = conversation[key];
          if (!peer?.id || peer.id === currentUserId) continue;
          const s = await prisma.userSettings.findUnique({
            where: { userId: peer.id },
            select: { showOnlineStatus: true },
          });
          if (s && s.showOnlineStatus === false) {
            conversation = { ...conversation, [key]: { ...peer, isOnline: false, lastSeen: null } };
          }
        }
      }
    } catch (_) {}
    res.status(200).json({ success: true, data: { conversation } });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get conversation', code: 'GET_CONVERSATION_ERROR' });
  }
});

router.post('/:conversationId/read', authenticateToken, requireConversationAccess, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const currentUserId = req.userId;
    const conv = req.conversation;
    const readAt = new Date();
    const data = conv.user1Id === currentUserId ? { user1LastReadAt: readAt } : { user2LastReadAt: readAt };
    await prisma.conversation.update({ where: { id: conversationId }, data });
    try {
      const settings = await prisma.userSettings.findUnique({
        where: { userId: currentUserId },
        select: { showReadReceipts: true },
      });
      const allowReceipts = !settings || settings.showReadReceipts !== false;
      if (allowReceipts) {
        const otherId = conv.user1Id === currentUserId ? conv.user2Id : conv.user1Id;
        const io = req.app?.get?.('io');
        if (io && otherId) {
          io.to(`user:${otherId}`).emit('conversation:read', {
            conversationId,
            userId: currentUserId,
            readAt: readAt.toISOString(),
          });
        }
      }
    } catch (e) {
      console.warn('read receipt emit', e?.message);
    }
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(200).json({ success: true });
  }
});

router.post('/:conversationId/archive', authenticateToken, requireConversationAccess, async (req, res) => {
  try {
    const currentUserId = req.userId;
    const conv = req.conversation;
    const data = conv.user1Id === currentUserId ? { user1ArchivedAt: new Date() } : { user2ArchivedAt: new Date() };
    await prisma.conversation.update({ where: { id: req.params.conversationId }, data });
    res.json({ success: true, data: { archived: true } });
  } catch (error) {
    res.status(500).json({ error: 'Failed to archive', code: 'ARCHIVE_ERROR' });
  }
});

router.post('/:conversationId/unarchive', authenticateToken, requireConversationAccess, async (req, res) => {
  try {
    const currentUserId = req.userId;
    const conv = req.conversation;
    const data = conv.user1Id === currentUserId ? { user1ArchivedAt: null } : { user2ArchivedAt: null };
    await prisma.conversation.update({ where: { id: req.params.conversationId }, data });
    res.json({ success: true, data: { archived: false } });
  } catch (error) {
    res.status(500).json({ error: 'Failed to unarchive', code: 'UNARCHIVE_ERROR' });
  }
});

export default router;
