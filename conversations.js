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
      if (lastRead) {
        where.createdAt = { gt: lastRead };
      }
      const unreadCount = await prisma.message.count({ where });
      out.push({ ...c, unreadCount });
    } catch (e) {
      console.warn('unread count', c.id, e?.message);
      out.push({ ...c, unreadCount: 0 });
    }
  }
  return out;
}

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

    // Identity: allowUnknownMessages — only block *new* threads when target opted out
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
