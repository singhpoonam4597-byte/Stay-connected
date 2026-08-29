import express from 'express';
import { prisma } from '../server.js';
import { authenticateToken, requireConversationAccess, requireGroupMembership } from '../middleware/auth.js';

const router = express.Router();

// ============================================================================
// SEND MESSAGE TO CONVERSATION ENDPOINT
// ============================================================================

router.post('/conversation', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { conversationId, content, replyToId } = req.body;

    if (!conversationId) {
      return res.status(400).json({
        error: 'Conversation ID is required',
        code: 'MISSING_CONVERSATION_ID'
      });
    }

    if (!content || content.trim().length === 0) {
      return res.status(400).json({
        error: 'Message content is required',
        code: 'EMPTY_CONTENT'
      });
    }

    if (content.length > 5000) {
      return res.status(400).json({
        error: 'Message is too long (max 5000 characters)',
        code: 'CONTENT_TOO_LONG'
      });
    }

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId }
    });

    if (!conversation) {
      return res.status(404).json({
        error: 'Conversation not found',
        code: 'NOT_FOUND'
      });
    }

    if (conversation.user1Id !== userId && conversation.user2Id !== userId) {
      return res.status(403).json({
        error: 'You do not have access to this conversation',
        code: 'NO_ACCESS'
      });
    }

    if (replyToId) {
      const replyMessage = await prisma.message.findUnique({
        where: { id: replyToId }
      });

      if (!replyMessage || replyMessage.conversationId !== conversationId) {
        return res.status(404).json({
          error: 'Reply message not found in this conversation',
          code: 'REPLY_NOT_FOUND'
        });
      }
    }

    const message = await prisma.message.create({
      data: {
        content: content.trim(),
        senderId: userId,
        conversationId,
        replyToId: replyToId || null
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
        replyTo: {
          select: {
            id: true,
            content: true,
            sender: {
              select: { displayName: true }
            }
          }
        },
        reactions: true,
        attachments: true
      }
    });

    await prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessage: content.substring(0, 100),
        lastMessageAt: new Date(),
        lastMessageBy: userId
      }
    });

    res.status(201).json({
      success: true,
      data: { message }
    });
  } catch (error) {
    console.error('Send message error:', error);

    res.status(500).json({
      error: 'Failed to send message',
      code: 'SEND_ERROR'
    });
  }
});

// ============================================================================
// SEND MESSAGE TO GROUP ENDPOINT
// ============================================================================

router.post('/group', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { groupId, content, replyToId } = req.body;

    if (!groupId) {
      return res.status(400).json({
        error: 'Group ID is required',
        code: 'MISSING_GROUP_ID'
      });
    }

    if (!content || content.trim().length === 0) {
      return res.status(400).json({
        error: 'Message content is required',
        code: 'EMPTY_CONTENT'
      });
    }

    if (content.length > 5000) {
      return res.status(400).json({
        error: 'Message is too long (max 5000 characters)',
        code: 'CONTENT_TOO_LONG'
      });
    }

    const group = await prisma.group.findUnique({
      where: { id: groupId },
      include: { members: true }
    });

    if (!group) {
      return res.status(404).json({
        error: 'Group not found',
        code: 'NOT_FOUND'
      });
    }

    const isMember = group.members.some(m => m.userId === userId);

    if (!isMember) {
      return res.status(403).json({
        error: 'You are not a member of this group',
        code: 'NOT_MEMBER'
      });
    }

    if (replyToId) {
      const replyMessage = await prisma.message.findUnique({
        where: { id: replyToId }
      });

      if (!replyMessage || replyMessage.groupId !== groupId) {
        return res.status(404).json({
          error: 'Reply message not found in this group',
          code: 'REPLY_NOT_FOUND'
        });
      }
    }

    const message = await prisma.message.create({
      data: {
        content: content.trim(),
        senderId: userId,
        groupId,
        replyToId: replyToId || null
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
        replyTo: {
          select: {
            id: true,
            content: true,
            sender: {
              select: { displayName: true }
            }
          }
        },
        reactions: true,
        attachments: true
      }
    });

    await prisma.group.update({
      where: { id: groupId },
      data: {
        updatedAt: new Date()
      }
    });

    res.status(201).json({
      success: true,
      data: { message }
    });
  } catch (error) {
    console.error('Send group message error:', error);

    res.status(500).json({
      error: 'Failed to send message',
      code: 'SEND_ERROR'
    });
  }
});

// ============================================================================
// EDIT MESSAGE ENDPOINT
// ============================================================================

router.patch('/:messageId', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { messageId } = req.params;
    const { content } = req.body;

    if (!content || content.trim().length === 0) {
      return res.status(400).json({
        error: 'Message content is required',
        code: 'EMPTY_CONTENT'
      });
    }

    if (content.length > 5000) {
      return res.status(400).json({
        error: 'Message is too long (max 5000 characters)',
        code: 'CONTENT_TOO_LONG'
      });
    }

    const message = await prisma.message.findUnique({
      where: { id: messageId }
    });

    if (!message) {
      return res.status(404).json({
        error: 'Message not found',
        code: 'NOT_FOUND'
      });
    }

    if (message.senderId !== userId) {
      return res.status(403).json({
        error: 'You can only edit your own messages',
        code: 'NOT_AUTHORIZED'
      });
    }

    const updatedMessage = await prisma.message.update({
      where: { id: messageId },
      data: {
        content: content.trim(),
        isEdited: true,
        editedAt: new Date()
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
        reactions: true,
        attachments: true
      }
    });

    res.status(200).json({
      success: true,
      data: { message: updatedMessage }
    });
  } catch (error) {
    console.error('Edit message error:', error);

    res.status(500).json({
      error: 'Failed to edit message',
      code: 'EDIT_ERROR'
    });
  }
});

// ============================================================================
// DELETE MESSAGE ENDPOINT
// ============================================================================

router.delete('/:messageId', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { messageId } = req.params;

    const message = await prisma.message.findUnique({
      where: { id: messageId }
    });

    if (!message) {
      return res.status(404).json({
        error: 'Message not found',
        code: 'NOT_FOUND'
      });
    }

    if (message.senderId !== userId) {
      return res.status(403).json({
        error: 'You can only delete your own messages',
        code: 'NOT_AUTHORIZED'
      });
    }

    await prisma.message.delete({
      where: { id: messageId }
    });

    res.status(200).json({
      success: true,
      message: 'Message deleted'
    });
  } catch (error) {
    console.error('Delete message error:', error);

    res.status(500).json({
      error: 'Failed to delete message',
      code: 'DELETE_ERROR'
    });
  }
});

// ============================================================================
// ADD REACTION ENDPOINT
// ============================================================================

router.post('/:messageId/react', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { messageId } = req.params;
    const { emoji } = req.body;

    if (!emoji) {
      return res.status(400).json({
        error: 'Emoji is required',
        code: 'MISSING_EMOJI'
      });
    }

    const message = await prisma.message.findUnique({
      where: { id: messageId }
    });

    if (!message) {
      return res.status(404).json({
        error: 'Message not found',
        code: 'NOT_FOUND'
      });
    }

    const existingReaction = await prisma.reaction.findUnique({
      where: {
        messageId_userId_emoji: {
          messageId,
          userId,
          emoji
        }
      }
    });

    if (existingReaction) {
      return res.status(409).json({
        error: 'You have already reacted with this emoji',
        code: 'REACTION_EXISTS'
      });
    }

    const reaction = await prisma.reaction.create({
      data: {
        messageId,
        userId,
        emoji
      }
    });

    const updatedMessage = await prisma.message.findUnique({
      where: { id: messageId },
      include: {
        reactions: {
          include: {
            user: {
              select: { id: true, displayName: true }
            }
          }
        }
      }
    });

    res.status(201).json({
      success: true,
      data: { reaction, message: updatedMessage }
    });
  } catch (error) {
    console.error('Add reaction error:', error);

    res.status(500).json({
      error: 'Failed to add reaction',
      code: 'REACTION_ERROR'
    });
  }
});

// ============================================================================
// REMOVE REACTION ENDPOINT
// ============================================================================

router.delete('/:messageId/react/:emoji', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { messageId, emoji } = req.params;

    const reaction = await prisma.reaction.findUnique({
      where: {
        messageId_userId_emoji: {
          messageId,
          userId,
          emoji
        }
      }
    });

    if (!reaction) {
      return res.status(404).json({
        error: 'Reaction not found',
        code: 'NOT_FOUND'
      });
    }

    await prisma.reaction.delete({
      where: {
        messageId_userId_emoji: {
          messageId,
          userId,
          emoji
        }
      }
    });

    const updatedMessage = await prisma.message.findUnique({
      where: { id: messageId },
      include: {
        reactions: {
          include: {
            user: {
              select: { id: true, displayName: true }
            }
          }
        }
      }
    });

    res.status(200).json({
      success: true,
      data: { message: updatedMessage }
    });
  } catch (error) {
    console.error('Remove reaction error:', error);

    res.status(500).json({
      error: 'Failed to remove reaction',
      code: 'REACTION_ERROR'
    });
  }
});

// ============================================================================
// PIN MESSAGE ENDPOINT
// ============================================================================

router.post('/:messageId/pin', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { messageId } = req.params;

    const message = await prisma.message.findUnique({
      where: { id: messageId }
    });

    if (!message) {
      return res.status(404).json({
        error: 'Message not found',
        code: 'NOT_FOUND'
      });
    }

    if (message.groupId) {
      const group = await prisma.group.findUnique({
        where: { id: message.groupId },
        include: { members: true }
      });

      const member = group.members.find(m => m.userId === userId);
      if (!member || (member.role !== 'admin' && group.createdById !== userId)) {
        return res.status(403).json({
          error: 'You do not have permission to pin messages',
          code: 'NOT_AUTHORIZED'
        });
      }
    }

    const pinnedMessage = await prisma.message.update({
      where: { id: messageId },
      data: {
        isPinned: true,
        pinnedBy: userId,
        pinnedAt: new Date()
      }
    });

    res.status(200).json({
      success: true,
      data: { message: pinnedMessage }
    });
  } catch (error) {
    console.error('Pin message error:', error);

    res.status(500).json({
      error: 'Failed to pin message',
      code: 'PIN_ERROR'
    });
  }
});

// ============================================================================
// UNPIN MESSAGE ENDPOINT
// ============================================================================

router.delete('/:messageId/pin', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { messageId } = req.params;

    const message = await prisma.message.findUnique({
      where: { id: messageId }
    });

    if (!message) {
      return res.status(404).json({
        error: 'Message not found',
        code: 'NOT_FOUND'
      });
    }

    if (!message.isPinned) {
      return res.status(400).json({
        error: 'Message is not pinned',
        code: 'NOT_PINNED'
      });
    }

    const unpinnedMessage = await prisma.message.update({
      where: { id: messageId },
      data: {
        isPinned: false,
        pinnedBy: null,
        pinnedAt: null
      }
    });

    res.status(200).json({
      success: true,
      data: { message: unpinnedMessage }
    });
  } catch (error) {
    console.error('Unpin message error:', error);

    res.status(500).json({
      error: 'Failed to unpin message',
      code: 'UNPIN_ERROR'
    });
  }
});

// ============================================================================
// GET MESSAGE REPLIES ENDPOINT
// ============================================================================

router.get('/:messageId/replies', authenticateToken, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { limit = 50 } = req.query;

    const message = await prisma.message.findUnique({
      where: { id: messageId }
    });

    if (!message) {
      return res.status(404).json({
        error: 'Message not found',
        code: 'NOT_FOUND'
      });
    }

    const replies = await prisma.message.findMany({
      where: { replyToId: messageId },
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
      orderBy: { createdAt: 'asc' },
      take: Math.min(parseInt(limit) || 50, 100)
    });

    res.status(200).json({
      success: true,
      data: {
        replies,
        count: replies.length
      }
    });
  } catch (error) {
    console.error('Get replies error:', error);

    res.status(500).json({
      error: 'Failed to fetch replies',
      code: 'FETCH_ERROR'
    });
  }
});

export default router;
