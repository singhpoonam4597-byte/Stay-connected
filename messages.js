import express from 'express';
import { prisma } from './server.js';
import { authenticateToken } from './jwt.js';

const router = express.Router();

function broadcast(req, room, event, payload) {
  try {
    const io = req.app.get('io');
    if (io) io.to(room).emit(event, payload);
  } catch (e) {
    console.error('Socket broadcast failed:', e?.message || e);
  }
}

function serializeMessage(m) {
  if (!m || typeof m !== 'object') return m;
  const out = { ...m };
  if (Array.isArray(out.attachments)) {
    out.attachments = out.attachments.map((a) => ({
      ...a,
      fileSize: typeof a.fileSize === 'bigint' ? Number(a.fileSize) : a.fileSize,
    }));
  }
  return out;
}

async function sendConversationMessage(req, res) {
  try {
    const userId = req.user?.id || req.userId;
    const body = req.body || {};
    const conversationId = body.conversationId || body.conversation_id;
    const content = body.content || body.text || body.message;
    const replyToId = body.replyToId || body.reply_to_id || null;
    const attachmentIds = body.attachmentIds || body.attachment_ids || [];

    if (!conversationId) {
      return res.status(400).json({ error: 'Conversation ID is required', code: 'MISSING_CONVERSATION_ID' });
    }
    const hasText = content && String(content).trim().length > 0;
    const hasAttachments = Array.isArray(attachmentIds) && attachmentIds.length > 0;
    if (!hasText && !hasAttachments) {
      return res.status(400).json({ error: 'Message content or attachment is required', code: 'EMPTY_CONTENT' });
    }
    if (hasText && String(content).length > 5000) {
      return res.status(400).json({ error: 'Message is too long (max 5000 characters)', code: 'CONTENT_TOO_LONG' });
    }

    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found', code: 'NOT_FOUND' });
    }
    if (conversation.user1Id !== userId && conversation.user2Id !== userId) {
      return res.status(403).json({ error: 'You do not have access to this conversation', code: 'NO_ACCESS' });
    }

    const otherId =
      conversation.user1Id === userId ? conversation.user2Id : conversation.user1Id;
    const blocked = await prisma.blockedUser.findFirst({
      where: {
        OR: [
          { blockerId: userId, blockedId: otherId },
          { blockerId: otherId, blockedId: userId },
        ],
      },
    });
    if (blocked) {
      return res.status(403).json({
        error: 'You cannot message this user',
        code: 'USER_BLOCKED',
      });
    }

    if (replyToId) {
      const replyMessage = await prisma.message.findUnique({ where: { id: replyToId } });
      if (!replyMessage || replyMessage.conversationId !== conversationId || replyMessage.isDeleted) {
        return res.status(404).json({ error: 'Reply message not found in this conversation', code: 'REPLY_NOT_FOUND' });
      }
    }

    const trimmed = hasText ? String(content).trim() : (hasAttachments ? '📷 Photo' : '');
    const message = await prisma.message.create({
      data: {
        content: trimmed,
        senderId: userId,
        conversationId,
        replyToId: replyToId || null,
      },
      select: {
        id: true,
        content: true,
        senderId: true,
        conversationId: true,
        groupId: true,
        replyToId: true,
        isDeleted: true,
        isEdited: true,
        isPinned: true,
        createdAt: true,
        updatedAt: true,
        sender: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatar: true,
            avatarColor: true,
          },
        },
        replyTo: replyToId
          ? {
              select: {
                id: true,
                content: true,
                isDeleted: true,
                sender: { select: { displayName: true } },
              },
            }
          : false,
        reactions: true,
        attachments: true,
      },
    });

    if (hasAttachments) {
      await prisma.attachment.updateMany({
        where: { id: { in: attachmentIds }, uploadedBy: userId, messageId: null },
        data: { messageId: message.id },
      });
      const full = await prisma.message.findUnique({
        where: { id: message.id },
        select: {
          id: true,
          content: true,
          senderId: true,
          conversationId: true,
          createdAt: true,
          sender: {
            select: {
              id: true,
              username: true,
              displayName: true,
              avatar: true,
              avatarColor: true,
            },
          },
          attachments: true,
          replyTo: true,
          reactions: true,
        },
      });
      if (full) Object.assign(message, full);
    }

    const safe = serializeMessage(message);
    broadcast(req, `conversation:${conversationId}`, 'message:new', {
      message: safe,
      conversationId,
    });

    prisma.conversation
      .update({
        where: { id: conversationId },
        data: {
          lastMessage: trimmed.substring(0, 100),
          lastMessageAt: new Date(),
          lastMessageBy: userId,
        },
      })
      .catch((e) => console.error('conversation preview update', e?.message));

    res.status(201).json({ success: true, data: { message: safe } });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ error: 'Failed to send message', code: 'SEND_ERROR' });
  }
}

async function sendGroupMessage(req, res) {
  try {
    const userId = req.user?.id || req.userId;
    const body = req.body || {};
    const groupId = body.groupId || body.group_id;
    const content = body.content || body.text || body.message;
    const replyToId = body.replyToId || body.reply_to_id || null;
    const attachmentIds = body.attachmentIds || body.attachment_ids || [];

    if (!groupId) {
      return res.status(400).json({ error: 'Group ID is required', code: 'MISSING_GROUP_ID' });
    }
    const hasText = content && String(content).trim().length > 0;
    const hasAttachments = Array.isArray(attachmentIds) && attachmentIds.length > 0;
    if (!hasText && !hasAttachments) {
      return res.status(400).json({ error: 'Message content or attachment is required', code: 'EMPTY_CONTENT' });
    }
    if (hasText && String(content).length > 5000) {
      return res.status(400).json({ error: 'Message is too long (max 5000 characters)', code: 'CONTENT_TOO_LONG' });
    }

    const group = await prisma.group.findUnique({
      where: { id: groupId },
      include: { members: true },
    });
    if (!group) {
      return res.status(404).json({ error: 'Group not found', code: 'NOT_FOUND' });
    }
    if (!group.members.some((m) => m.userId === userId)) {
      return res.status(403).json({ error: 'You are not a member of this group', code: 'NOT_MEMBER' });
    }

    if (replyToId) {
      const replyMessage = await prisma.message.findUnique({ where: { id: replyToId } });
      if (!replyMessage || replyMessage.groupId !== groupId || replyMessage.isDeleted) {
        return res.status(404).json({ error: 'Reply message not found in this group', code: 'REPLY_NOT_FOUND' });
      }
    }

    const trimmed = hasText ? String(content).trim() : (hasAttachments ? '📷 Photo' : '');
    const message = await prisma.message.create({
      data: {
        content: trimmed,
        senderId: userId,
        groupId,
        replyToId: replyToId || null,
      },
      include: {
        sender: { select: { id: true, username: true, displayName: true, avatar: true } },
        replyTo: {
          select: {
            id: true,
            content: true,
            isDeleted: true,
            sender: { select: { displayName: true } },
          },
        },
        reactions: true,
        attachments: true,
      },
    });

    if (hasAttachments) {
      await prisma.attachment.updateMany({
        where: { id: { in: attachmentIds }, uploadedBy: userId, messageId: null },
        data: { messageId: message.id },
      });
      const full = await prisma.message.findUnique({
        where: { id: message.id },
        include: {
          sender: { select: { id: true, username: true, displayName: true, avatar: true } },
          replyTo: {
            select: {
              id: true,
              content: true,
              isDeleted: true,
              sender: { select: { displayName: true } },
            },
          },
          reactions: true,
          attachments: true,
        },
      });
      if (full) Object.assign(message, full);
    }

    const safe = serializeMessage(message);
    broadcast(req, `group:${groupId}`, 'message:new', {
      message: safe,
      groupId,
    });

    prisma.group
      .update({ where: { id: groupId }, data: { updatedAt: new Date() } })
      .catch((e) => console.error('group preview update', e?.message));

    res.status(201).json({ success: true, data: { message: safe } });
  } catch (error) {
    console.error('Send group message error:', error);
    res.status(500).json({ error: 'Failed to send message', code: 'SEND_ERROR' });
  }
}

router.post('/', authenticateToken, async (req, res) => {
  if (req.body?.groupId || req.body?.group_id) return sendGroupMessage(req, res);
  return sendConversationMessage(req, res);
});

router.post('/conversation', authenticateToken, sendConversationMessage);
router.post('/group', authenticateToken, sendGroupMessage);

router.patch('/:messageId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const { messageId } = req.params;
    const content = req.body?.content || req.body?.text;

    if (!content || String(content).trim().length === 0) {
      return res.status(400).json({ error: 'Message content is required', code: 'EMPTY_CONTENT' });
    }
    if (String(content).length > 5000) {
      return res.status(400).json({ error: 'Message is too long (max 5000 characters)', code: 'CONTENT_TOO_LONG' });
    }

    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.isDeleted) {
      return res.status(404).json({ error: 'Message not found', code: 'NOT_FOUND' });
    }
    if (message.senderId !== userId) {
      return res.status(403).json({ error: 'You can only edit your own messages', code: 'NOT_AUTHORIZED' });
    }

    const updatedMessage = await prisma.message.update({
      where: { id: messageId },
      data: {
        content: String(content).trim(),
        isEdited: true,
        editedAt: new Date(),
      },
      include: {
        sender: { select: { id: true, username: true, displayName: true, avatar: true } },
        reactions: true,
        attachments: true,
      },
    });

    const room = message.conversationId
      ? `conversation:${message.conversationId}`
      : `group:${message.groupId}`;
    const safe = serializeMessage(updatedMessage);
    broadcast(req, room, 'message:edited', { message: safe, messageId });

    res.status(200).json({ success: true, data: { message: safe } });
  } catch (error) {
    console.error('Edit message error:', error);
    res.status(500).json({ error: 'Failed to edit message', code: 'EDIT_ERROR' });
  }
});

router.delete('/:messageId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const { messageId } = req.params;

    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.isDeleted) {
      return res.status(404).json({ error: 'Message not found', code: 'NOT_FOUND' });
    }
    if (message.senderId !== userId) {
      return res.status(403).json({ error: 'You can only delete your own messages', code: 'NOT_AUTHORIZED' });
    }

    await prisma.message.update({
      where: { id: messageId },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        content: '',
      },
    });

    const room = message.conversationId
      ? `conversation:${message.conversationId}`
      : `group:${message.groupId}`;
    broadcast(req, room, 'message:deleted', { messageId });

    res.status(200).json({ success: true, message: 'Message deleted' });
  } catch (error) {
    console.error('Delete message error:', error);
    res.status(500).json({ error: 'Failed to delete message', code: 'DELETE_ERROR' });
  }
});

router.post('/:messageId/react', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const { messageId } = req.params;
    const { emoji } = req.body;

    if (!emoji) {
      return res.status(400).json({ error: 'Emoji is required', code: 'MISSING_EMOJI' });
    }

    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.isDeleted) {
      return res.status(404).json({ error: 'Message not found', code: 'NOT_FOUND' });
    }

    const existingReaction = await prisma.reaction.findUnique({
      where: { messageId_userId_emoji: { messageId, userId, emoji } },
    });
    if (existingReaction) {
      return res.status(409).json({ error: 'You have already reacted with this emoji', code: 'REACTION_EXISTS' });
    }

    const reaction = await prisma.reaction.create({
      data: { messageId, userId, emoji },
    });

    const updatedMessage = await prisma.message.findUnique({
      where: { id: messageId },
      include: {
        reactions: { include: { user: { select: { id: true, displayName: true } } } },
      },
    });

    const room = message.conversationId
      ? `conversation:${message.conversationId}`
      : `group:${message.groupId}`;
    broadcast(req, room, 'message:reaction', { message: updatedMessage, messageId });

    res.status(201).json({ success: true, data: { reaction, message: updatedMessage } });
  } catch (error) {
    console.error('Add reaction error:', error);
    res.status(500).json({ error: 'Failed to add reaction', code: 'REACTION_ERROR' });
  }
});

router.delete('/:messageId/react/:emoji', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const { messageId, emoji } = req.params;

    const reaction = await prisma.reaction.findUnique({
      where: { messageId_userId_emoji: { messageId, userId, emoji } },
    });
    if (!reaction) {
      return res.status(404).json({ error: 'Reaction not found', code: 'NOT_FOUND' });
    }

    await prisma.reaction.delete({
      where: { messageId_userId_emoji: { messageId, userId, emoji } },
    });

    const updatedMessage = await prisma.message.findUnique({
      where: { id: messageId },
      include: {
        reactions: { include: { user: { select: { id: true, displayName: true } } } },
      },
    });

    res.status(200).json({ success: true, data: { message: updatedMessage } });
  } catch (error) {
    console.error('Remove reaction error:', error);
    res.status(500).json({ error: 'Failed to remove reaction', code: 'REACTION_ERROR' });
  }
});

router.post('/:messageId/pin', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const { messageId } = req.params;

    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.isDeleted) {
      return res.status(404).json({ error: 'Message not found', code: 'NOT_FOUND' });
    }

    if (message.groupId) {
      const group = await prisma.group.findUnique({
        where: { id: message.groupId },
        include: { members: true },
      });
      const member = group?.members.find((m) => m.userId === userId);
      if (!member || (member.role !== 'admin' && group.createdById !== userId)) {
        return res.status(403).json({ error: 'You do not have permission to pin messages', code: 'NOT_AUTHORIZED' });
      }
    }

    const pinnedMessage = await prisma.message.update({
      where: { id: messageId },
      data: { isPinned: true, pinnedBy: userId, pinnedAt: new Date() },
    });

    res.status(200).json({ success: true, data: { message: pinnedMessage } });
  } catch (error) {
    console.error('Pin message error:', error);
    res.status(500).json({ error: 'Failed to pin message', code: 'PIN_ERROR' });
  }
});

router.delete('/:messageId/pin', authenticateToken, async (req, res) => {
  try {
    const { messageId } = req.params;

    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message) {
      return res.status(404).json({ error: 'Message not found', code: 'NOT_FOUND' });
    }
    if (!message.isPinned) {
      return res.status(400).json({ error: 'Message is not pinned', code: 'NOT_PINNED' });
    }

    const unpinnedMessage = await prisma.message.update({
      where: { id: messageId },
      data: { isPinned: false, pinnedBy: null, pinnedAt: null },
    });

    res.status(200).json({ success: true, data: { message: unpinnedMessage } });
  } catch (error) {
    console.error('Unpin message error:', error);
    res.status(500).json({ error: 'Failed to unpin message', code: 'UNPIN_ERROR' });
  }
});

router.get('/:messageId/replies', authenticateToken, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { limit = 50 } = req.query;

    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message || message.isDeleted) {
      return res.status(404).json({ error: 'Message not found', code: 'NOT_FOUND' });
    }

    const replies = await prisma.message.findMany({
      where: { replyToId: messageId, isDeleted: false },
      include: {
        sender: { select: { id: true, username: true, displayName: true, avatar: true } },
        reactions: true,
      },
      orderBy: { createdAt: 'asc' },
      take: Math.min(parseInt(limit) || 50, 100),
    });

    res.status(200).json({ success: true, data: { replies, count: replies.length } });
  } catch (error) {
    console.error('Get replies error:', error);
    res.status(500).json({ error: 'Failed to fetch replies', code: 'FETCH_ERROR' });
  }
});

export default router;
