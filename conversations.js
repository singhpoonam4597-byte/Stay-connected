import express from 'express';
import { prisma } from './server.js';
import { authenticateToken, requireConversationAccess } from './jwt.js';

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
          { user1Id: currentUserId },
          { user2Id: currentUserId }
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
// GET CONVERSATION MESSAGES ENDPOINT
// ============================================================================

router.get('/:conversationId/messages', authenticateToken, requireConversationAccess, async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const messages = await prisma.message.findMany({
      where: { conversationId },
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

    const total = await prisma.message.count({
      where: { conversationId }
    });

    res.status(200).json({
      success: true,
      data: {
        messages: messages.reverse(),
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
