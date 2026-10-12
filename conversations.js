import express from 'express';
import { prisma } from './prisma.js';
import { authenticateToken, requireConversationAccess } from './auth.js';

const router = express.Router();

// ============================================================================
// CREATE/GET CONVERSATION ENDPOINT
// ============================================================================

router.post('/', authenticateToken, async (req, res) => {
  try {
    const currentUserId = req.userId;
    const { otherUserId } = req.body;

    if (!otherUserId) {
      return res.status(400).json({
        error: 'Other user ID is required',
        code: 'MISSING_USER_ID'
      });
    }

    if (currentUserId === otherUserId) {
      return res.status(400).json({
        error: 'You cannot create a conversation with yourself',
        code: 'SELF_CONVERSATION'
      });
    }

    const otherUser = await prisma.user.findUnique({
      where: { id: otherUserId },
      select: { id: true, isPrivate: true }
    });

    if (!otherUser) {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    const blocked = await prisma.blockedUser.findFirst({
      where: {
        OR: [
          { blockerId: currentUserId, blockedId: otherUserId },
          { blockerId: otherUserId, blockedId: currentUserId }
        ]
      }
    });

    if (blocked) {
      return res.status(403).json({
        error: 'You cannot message this user',
        code: 'USER_BLOCKED'
      });
    }

    let conversation = await prisma.conversation.findFirst({
      where: {
        OR: [
          { user1Id: currentUserId, user2Id: otherUserId },
          { user1Id: otherUserId, user2Id: currentUserId }
        ]
      },
      include: {
        user1: { select: { id: true, username: true, displayName: true, avatar: true, isOnline: true } },
        user2: { select: { id: true, username: true, displayName: true, avatar: true, isOnline: true } },
        _count: { select: { messages: true } }
      }
    });

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          user1Id: currentUserId,
          user2Id: otherUserId
        },
        include: {
          user1: { select: { id: true, username: true, displayName: true, avatar: true, isOnline: true } },
          user2: { select: { id: true, username: true, displayName: true, avatar: true, isOnline: true } },
          _count: { select: { messages: true } }
        }
      });
    }

    res.status(201).json({
      success: true,
      data: { conversation }
    });
  } catch (error) {
    console.error('Create conversation error:', error);

    res.status(500).json({
      error: 'Failed to create conversation',
      code: 'CREATE_ERROR'
    });
  }
});

// ============================================================================
// GET ALL CONVERSATIONS ENDPOINT
// ============================================================================

router.get('/', authenticateToken, async (req, res) => {
  try {
    const currentUserId = req.userId;
    const { limit = 50, offset = 0 } = req.query;

    const conversations = await prisma.conversation.findMany({
      where: {
        OR: [
          { user1Id: currentUserId, user1ArchivedAt: null },
          { user2Id: currentUserId, user2ArchivedAt: null }
        ]
      },
      include: {
        user1: { select: { id: true, username: true, displayName: true, avatar: true, isOnline: true } },
        user2: { select: { id: true, username: true, displayName: true, avatar: true, isOnline: true } },
        _count: { select: { messages: true } }
      },
      orderBy: { lastMessageAt: 'desc' },
      take: Math.min(parseInt(limit) || 50, 100),
      skip: Math.max(parseInt(offset) || 0, 0)
    });

    const total = await prisma.conversation.count({
      where: {
        OR: [
          { user1Id: currentUserId },
          { user2Id: currentUserId }
        ]
      }
    });

    res.status(200).json({
      success: true,
      data: {
        conversations,
        total,
        limit: Math.min(parseInt(limit) || 50, 100),
        offset: Math.max(parseInt(offset) || 0, 0)
      }
    });
  } catch (error) {
    console.error('Get conversations error:', error);

    res.status(500).json({
      error: 'Failed to fetch conversations',
      code: 'FETCH_ERROR'
    });
  }
});

// ============================================================================
// GET ARCHIVED CONVERSATIONS
// ============================================================================

router.get('/archived/list', authenticateToken, async (req, res) => {
  try {
    const currentUserId = req.userId;
    const conversations = await prisma.conversation.findMany({
      where: {
        OR: [
          { user1Id: currentUserId, user1ArchivedAt: { not: null } },
          { user2Id: currentUserId, user2ArchivedAt: { not: null } }
        ]
      },
      include: {
        user1: { select: { id: true, username: true, displayName: true, avatar: true, isOnline: true, avatarColor: true } },
        user2: { select: { id: true, username: true, displayName: true, avatar: true, isOnline: true, avatarColor: true } }
      },
      orderBy: { lastMessageAt: 'desc' }
    });
    res.json({ success: true, data: { conversations } });
  } catch (error) {
    console.error('Archived list error:', error);
    res.status(500).json({ error: 'Failed to load archived chats', code: 'ARCHIVE_LIST_ERROR' });
  }
});

// ============================================================================
// ARCHIVE / UNARCHIVE CONVERSATION (per-user)
// ============================================================================

router.post('/:conversationId/archive', authenticateToken, requireConversationAccess, async (req, res) => {
  try {
    const userId = req.userId;
    const { conversationId } = req.params;
    const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    const data =
      conv.user1Id === userId
        ? { user1ArchivedAt: new Date() }
        : { user2ArchivedAt: new Date() };
    await prisma.conversation.update({ where: { id: conversationId }, data });
    res.json({ success: true, data: { archived: true, conversationId } });
  } catch (error) {
    console.error('Archive error:', error);
    res.status(500).json({ error: 'Failed to archive', code: 'ARCHIVE_ERROR' });
  }
});

router.post('/:conversationId/unarchive', authenticateToken, requireConversationAccess, async (req, res) => {
  try {
    const userId = req.userId;
    const { conversationId } = req.params;
    const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conv) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    const data =
      conv.user1Id === userId
        ? { user1ArchivedAt: null }
        : { user2ArchivedAt: null };
    await prisma.conversation.update({ where: { id: conversationId }, data });
    res.json({ success: true, data: { archived: false, conversationId } });
  } catch (error) {
    console.error('Unarchive error:', error);
    res.status(500).json({ error: 'Failed to unarchive', code: 'UNARCHIVE_ERROR' });
  }
});

// ============================================================================
// GET CONVERSATION MESSAGES ENDPOINT
// ============================================================================

router.get('/:conversationId/messages', authenticateToken, requireConversationAccess, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const messages = await prisma.message.findMany({
      where: { conversationId, isDeleted: false },
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatar: true
          }
        },
        replyTo: {
          select: {
            id: true,
            content: true,
            sender: {
              select: { displayName: true }
            }
          }
        },
        reactions: {
          include: {
            user: {
              select: { id: true, displayName: true }
            }
          }
        },
        attachments: true
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit) || 50, 100),
      skip: Math.max(parseInt(offset) || 0, 0)
    });

    // Hide messages the user deleted "for me"
    const currentUserId = req.userId;
    let visible = messages;
    try {
      const ids = messages.map((m) => m.id);
      if (ids.length) {
        const hidden = await prisma.messageHide.findMany({
          where: { userId: currentUserId, messageId: { in: ids } },
          select: { messageId: true },
        });
        const hideSet = new Set(hidden.map((h) => h.messageId));
        visible = messages.filter((m) => !hideSet.has(m.id));
      }
    } catch (e) {
      // MessageHide table may not exist until prisma db push
      console.warn('messageHide filter skipped:', e?.message);
    }

    const total = await prisma.message.count({
      where: { conversationId, isDeleted: false }
    });

    res.status(200).json({
      success: true,
      data: {
        messages: visible.reverse(),
        total,
        limit: Math.min(parseInt(limit) || 50, 100),
        offset: Math.max(parseInt(offset) || 0, 0)
      }
    });
  } catch (error) {
    console.error('Get conversation messages error:', error);

    res.status(500).json({
      error: 'Failed to fetch messages',
      code: 'FETCH_ERROR'
    });
  }
});

// ============================================================================
// GET CONVERSATION BY ID ENDPOINT
// ============================================================================

router.get('/:conversationId', authenticateToken, requireConversationAccess, async (req, res) => {
  try {
    const { conversationId } = req.params;

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        user1: { select: { id: true, username: true, displayName: true, avatar: true, bio: true, isOnline: true, isVerified: true } },
        user2: { select: { id: true, username: true, displayName: true, avatar: true, bio: true, isOnline: true, isVerified: true } },
        _count: { select: { messages: true } }
      }
    });

    if (!conversation) {
      return res.status(404).json({
        error: 'Conversation not found',
        code: 'NOT_FOUND'
      });
    }

    res.status(200).json({
      success: true,
      data: { conversation }
    });
  } catch (error) {
    console.error('Get conversation error:', error);

    res.status(500).json({
      error: 'Failed to fetch conversation',
      code: 'FETCH_ERROR'
    });
  }
});

// ============================================================================
// DELETE CONVERSATION ENDPOINT
// ============================================================================

router.delete('/:conversationId', authenticateToken, requireConversationAccess, async (req, res) => {
  try {
    const { conversationId } = req.params;

    await prisma.message.deleteMany({
      where: { conversationId }
    });

    await prisma.conversation.delete({
      where: { id: conversationId }
    });

    res.status(200).json({
      success: true,
      message: 'Conversation deleted'
    });
  } catch (error) {
    console.error('Delete conversation error:', error);

    res.status(500).json({
      error: 'Failed to delete conversation',
      code: 'DELETE_ERROR'
    });
  }
});

// ============================================================================
// SEARCH CONVERSATION MESSAGES ENDPOINT
// ============================================================================

router.get('/:conversationId/search', authenticateToken, requireConversationAccess, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { q, limit = 20 } = req.query;

    if (!q || q.trim().length === 0) {
      return res.status(400).json({
        error: 'Search query is required',
        code: 'MISSING_QUERY'
      });
    }

    const searchTerm = q.trim();

    const messages = await prisma.message.findMany({
      where: {
        AND: [
          { conversationId },
          { content: { contains: searchTerm, mode: 'insensitive' } }
        ]
      },
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatar: true
          }
        },
        reactions: true
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit) || 20, 100)
    });

    res.status(200).json({
      success: true,
      data: {
        messages,
        count: messages.length
      }
    });
  } catch (error) {
    console.error('Search messages error:', error);

    res.status(500).json({
      error: 'Search failed',
      code: 'SEARCH_ERROR'
    });
  }
});

export default router;
