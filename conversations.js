import express from 'express';
import { prisma } from './prisma.js';
import { authenticateToken, requireConversationAccess } from './auth.js';

const router = express.Router();

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
    const [u1, u2] =
      currentUserId < otherUserId ? [currentUserId, otherUserId] : [otherUserId, currentUserId];
    let conversation = await prisma.conversation.findFirst({
      where: { user1Id: u1, user2Id: u2 },
      include: {
        user1: { select: { id: true, username: true, displayName: true, avatar: true, avatarColor: true, isOnline: true, lastSeen: true } },
        user2: { select: { id: true, username: true, displayName: true, avatar: true, avatarColor: true, isOnline: true, lastSeen: true } },
      },
    });
    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: { user1Id: u1, user2Id: u2 },
        include: {
          user1: { select: { id: true, username: true, displayName: true, avatar: true, avatarColor: true, isOnline: true, lastSeen: true } },
          user2: { select: { id: true, username: true, displayName: true, avatar: true, avatarColor: true, isOnline: true, lastSeen: true } },
        },
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
    let conversations = [];
    try {
      conversations = await prisma.conversation.findMany({
        where: {
          OR: [
            { user1Id: currentUserId, user1ArchivedAt: null },
            { user2Id: currentUserId, user2ArchivedAt: null },
          ],
        },
        include: {
          user1: { select: { id: true, username: true, displayName: true, avatar: true, avatarColor: true, isOnline: true, lastSeen: true } },
          user2: { select: { id: true, username: true, displayName: true, avatar: true, avatarColor: true, isOnline: true, lastSeen: true } },
        },
        orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
      });
    } catch (e) {
      console.warn('list archive filter fallback:', e?.message);
      conversations = await prisma.conversation.findMany({
        where: { OR: [{ user1Id: currentUserId }, { user2Id: currentUserId }] },
        include: {
          user1: { select: { id: true, username: true, displayName: true, avatar: true, isOnline: true, lastSeen: true } },
          user2: { select: { id: true, username: true, displayName: true, avatar: true, isOnline: true, lastSeen: true } },
        },
        orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
      });
    }
    res.status(200).json({ success: true, data: { conversations } });
  } catch (error) {
    console.error('List conversations error:', error);
    res.status(500).json({ error: 'Failed to load conversations', code: 'LIST_CONVERSATIONS_ERROR' });
  }
});

router.get('/archived/list', authenticateToken, async (req, res) => {
  try {
    const currentUserId = req.userId;
    const conversations = await prisma.conversation.findMany({
      where: {
        OR: [
          { user1Id: currentUserId, user1ArchivedAt: { not: null } },
          { user2Id: currentUserId, user2ArchivedAt: { not: null } },
        ],
      },
      include: {
        user1: { select: { id: true, username: true, displayName: true, avatar: true } },
        user2: { select: { id: true, username: true, displayName: true, avatar: true } },
      },
      orderBy: { lastMessageAt: 'desc' },
    });
    res.status(200).json({ success: true, data: { conversations } });
  } catch (error) {
    console.error('Archived list error:', error);
    res.status(200).json({ success: true, data: { conversations: [] } });
  }
});

router.post('/:conversationId/archive', authenticateToken, requireConversationAccess, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const currentUserId = req.userId;
    const conv = req.conversation;
    const data = conv.user1Id === currentUserId ? { user1ArchivedAt: new Date() } : { user2ArchivedAt: new Date() };
    await prisma.conversation.update({ where: { id: conversationId }, data });
    res.json({ success: true, data: { archived: true, conversationId } });
  } catch (error) {
    console.error('Archive error:', error);
    res.status(500).json({ error: 'Failed to archive', code: 'ARCHIVE_ERROR' });
  }
});

router.post('/:conversationId/unarchive', authenticateToken, requireConversationAccess, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const currentUserId = req.userId;
    const conv = req.conversation;
    const data = conv.user1Id === currentUserId ? { user1ArchivedAt: null } : { user2ArchivedAt: null };
    await prisma.conversation.update({ where: { id: conversationId }, data });
    res.json({ success: true, data: { archived: false, conversationId } });
  } catch (error) {
    console.error('Unarchive error:', error);
    res.status(500).json({ error: 'Failed to unarchive', code: 'UNARCHIVE_ERROR' });
  }
});

// GET MESSAGES — simplest reliable query
router.get('/:conversationId/messages', authenticateToken, requireConversationAccess, async (req, res) => {
  const { conversationId } = req.params;
  const limit = Math.min(parseInt(String(req.query.limit || '80'), 10) || 80, 100);
  const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);
  const currentUserId = req.userId;

  try {
    let rows = [];
    try {
      rows = await prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'asc' },
        take: limit,
        skip: offset,
      });
    } catch (e) {
      console.error('[messages] base query failed:', e?.message || e);
      return res.status(200).json({
        success: true,
        data: { messages: [], total: 0, limit, offset, warning: String(e?.message || e) },
      });
    }

    rows = (rows || []).filter((m) => m && m.isDeleted !== true);

    try {
      const ids = rows.map((m) => m.id).filter(Boolean);
      if (ids.length && currentUserId) {
        const hidden = await prisma.messageHide.findMany({
          where: { userId: currentUserId, messageId: { in: ids } },
          select: { messageId: true },
        });
        const hideSet = new Set(hidden.map((h) => h.messageId));
        rows = rows.filter((m) => !hideSet.has(m.id));
      }
    } catch (e) {
      console.warn('[messages] hide filter skipped:', e?.message);
    }

    const senderIds = [...new Set(rows.map((m) => m.senderId).filter(Boolean))];
    let senderMap = {};
    if (senderIds.length) {
      try {
        const senders = await prisma.user.findMany({
          where: { id: { in: senderIds } },
          select: {
            id: true,
            username: true,
            displayName: true,
            avatar: true,
            avatarColor: true,
          },
        });
        senderMap = Object.fromEntries(senders.map((s) => [s.id, s]));
      } catch (e) {
        console.warn('[messages] sender lookup skipped:', e?.message);
      }
    }

    const messages = rows.map((m) => ({
      ...m,
      sender: senderMap[m.senderId] || {
        id: m.senderId,
        displayName: 'User',
        username: '',
      },
    }));

    console.log(
      `[messages] conv=${conversationId} user=${currentUserId} raw=${rows.length} out=${messages.length}`
    );

    return res.status(200).json({
      success: true,
      data: { messages, total: messages.length, limit, offset },
    });
  } catch (error) {
    console.error('[messages] unexpected:', error?.message || error);
    return res.status(200).json({
      success: true,
      data: {
        messages: [],
        total: 0,
        limit,
        offset,
        warning: String(error?.message || error),
      },
    });
  }
});

router.get('/:conversationId', authenticateToken, requireConversationAccess, async (req, res) => {
  try {
    const conversation = await prisma.conversation.findUnique({
      where: { id: req.params.conversationId },
      include: {
        user1: { select: { id: true, username: true, displayName: true, avatar: true, avatarColor: true, isOnline: true, lastSeen: true } },
        user2: { select: { id: true, username: true, displayName: true, avatar: true, avatarColor: true, isOnline: true, lastSeen: true } },
      },
    });
    res.status(200).json({ success: true, data: { conversation } });
  } catch (error) {
    console.error('Get conversation error:', error);
    res.status(500).json({ error: 'Failed to get conversation', code: 'GET_CONVERSATION_ERROR' });
  }
});

router.delete('/:conversationId', authenticateToken, requireConversationAccess, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const currentUserId = req.userId;
    const msgs = await prisma.message.findMany({ where: { conversationId }, select: { id: true } });
    if (msgs.length) {
      try {
        await prisma.messageHide.createMany({
          data: msgs.map((m) => ({ messageId: m.id, userId: currentUserId })),
          skipDuplicates: true,
        });
      } catch (e) {
        console.warn('clear chat messageHide failed:', e?.message);
      }
    }
    res.status(200).json({ success: true, message: 'Chat cleared for you' });
  } catch (error) {
    console.error('Clear conversation error:', error);
    res.status(500).json({ error: 'Failed to clear chat', code: 'CLEAR_ERROR' });
  }
});

router.get('/:conversationId/search', authenticateToken, requireConversationAccess, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.status(400).json({ error: 'Query required', code: 'MISSING_QUERY' });
    const messages = await prisma.message.findMany({
      where: { conversationId, NOT: { isDeleted: true }, content: { contains: q, mode: 'insensitive' } },
      include: { sender: { select: { id: true, displayName: true, username: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.status(200).json({ success: true, data: { messages, count: messages.length } });
  } catch (error) {
    console.error('Search messages error:', error);
    res.status(500).json({ error: 'Search failed', code: 'SEARCH_ERROR' });
  }
});

router.post('/:conversationId/read', authenticateToken, requireConversationAccess, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const currentUserId = req.userId;
    const conv = req.conversation;
    const data = conv.user1Id === currentUserId ? { user1LastReadAt: new Date() } : { user2LastReadAt: new Date() };
    await prisma.conversation.update({ where: { id: conversationId }, data });
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Mark read error:', error);
    res.status(200).json({ success: true });
  }
});

export default router;
