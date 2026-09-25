import express from 'express';
import { prisma } from './server.js';

const router = express.Router();

// Auth already applied in server.js — no second authenticateToken needed.
// Inline block check (auth.js does not export middleware).
async function checkNotBlocked(req, res, next) {
  try {
    const userId = req.userId;
    const targetUserId = req.params.userId;
    if (!targetUserId || targetUserId === userId) return next();

    const blocked = await prisma.blockedUser.findFirst({
      where: {
        OR: [
          { blockerId: userId, blockedId: targetUserId },
          { blockerId: targetUserId, blockedId: userId },
        ],
      },
    });

    if (blocked) {
      return res.status(403).json({
        error: 'You cannot perform this action with this user',
        code: 'USER_BLOCKED',
      });
    }
    next();
  } catch (error) {
    return res.status(500).json({ error: 'Database error', code: 'DB_ERROR' });
  }
}

router.get('/search', async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;
    const currentUserId = req.userId;

    if (!q || q.trim().length === 0) {
      return res.status(400).json({
        error: 'Search query is required',
        code: 'MISSING_QUERY',
      });
    }

    const searchTerm = q.trim().toLowerCase();
    const maxLimit = Math.min(parseInt(limit) || 20, 100);

    const users = await prisma.user.findMany({
      where: {
        AND: [
          {
            OR: [
              { username: { contains: searchTerm, mode: 'insensitive' } },
              { displayName: { contains: searchTerm, mode: 'insensitive' } },
            ],
          },
          { id: { not: currentUserId } },
        ],
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        avatar: true,
        bio: true,
        isVerified: true,
        isOnline: true,
      },
      take: maxLimit,
      orderBy: [{ isVerified: 'desc' }, { lastSeen: 'desc' }],
    });

    res.status(200).json({
      success: true,
      data: { users, count: users.length },
    });
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ error: 'Search failed', code: 'SEARCH_ERROR' });
  }
});

router.get('/me/blocked', async (req, res) => {
  try {
    const blockedUsers = await prisma.blockedUser.findMany({
      where: { blockerId: req.userId },
      include: {
        blocked: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatar: true,
            isVerified: true,
            isOnline: true,
          },
        },
      },
    });
    res.status(200).json({
      success: true,
      data: {
        blockedUsers: blockedUsers.map((b) => ({
          blockId: b.id,
          user: b.blocked,
          blockedAt: b.createdAt,
        })),
        count: blockedUsers.length,
      },
    });
  } catch (error) {
    console.error('Get blocked users error:', error);
    res.status(500).json({ error: 'Failed to fetch blocked users' });
  }
});

router.patch('/me/profile', async (req, res) => {
  try {
    const userId = req.userId;
    const { displayName, bio, isPrivate } = req.body;
    const updateData = {};

    if (displayName !== undefined) {
      if (displayName.length > 100) {
        return res.status(400).json({ error: 'Display name must be less than 100 characters' });
      }
      updateData.displayName = displayName;
    }
    if (bio !== undefined) {
      if (bio.length > 500) {
        return res.status(400).json({ error: 'Bio must be less than 500 characters' });
      }
      updateData.bio = bio;
    }
    if (isPrivate !== undefined) updateData.isPrivate = isPrivate;

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        username: true,
        displayName: true,
        avatar: true,
        bio: true,
        isPrivate: true,
        isVerified: true,
        createdAt: true,
      },
    });

    res.status(200).json({ success: true, data: { user: updatedUser } });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile', code: 'UPDATE_ERROR' });
  }
});

router.get('/:userId', checkNotBlocked, async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        displayName: true,
        avatar: true,
        bio: true,
        isPrivate: true,
        isVerified: true,
        isOnline: true,
        lastSeen: true,
        createdAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
    }

    let friendship = null;
    const isCurrentUser = userId === currentUserId;

    if (!isCurrentUser) {
      friendship = await prisma.friendship.findFirst({
        where: {
          OR: [
            { initiatorId: currentUserId, receiverId: userId },
            { initiatorId: userId, receiverId: currentUserId },
          ],
        },
      });
    }

    res.status(200).json({
      success: true,
      data: {
        profile: user,
        isCurrentUser,
        friendship: friendship
          ? {
              id: friendship.id,
              status: friendship.status,
              initiator: friendship.initiatorId === currentUserId,
            }
          : null,
      },
    });
  } catch (error) {
    console.error('Get user profile error:', error);
    res.status(500).json({ error: 'Failed to fetch user profile', code: 'FETCH_ERROR' });
  }
});

router.post('/:userId/friend-request', async (req, res) => {
  try {
    const currentUserId = req.userId;
    const { userId } = req.params;
    if (currentUserId === userId) {
      return res.status(400).json({ error: 'You cannot send a friend request to yourself' });
    }
    const targetUser = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    const existing = await prisma.friendship.findFirst({
      where: {
        OR: [
          { initiatorId: currentUserId, receiverId: userId },
          { initiatorId: userId, receiverId: currentUserId },
        ],
      },
    });
    if (existing) {
      return res.status(409).json({
        error: 'Friendship request already exists',
        data: { status: existing.status },
      });
    }

    const friendship = await prisma.friendship.create({
      data: { initiatorId: currentUserId, receiverId: userId, status: 'pending' },
    });

    try {
      await prisma.notification.create({
        data: {
          userId,
          type: 'friend_request',
          title: 'Friend Request',
          content: 'You have a new friend request',
          link: `/user/${currentUserId}`,
        },
      });
    } catch {
      /* optional */
    }

    res.status(201).json({ success: true, data: { friendship } });
  } catch (error) {
    console.error('Send friend request error:', error);
    res.status(500).json({ error: 'Failed to send friend request' });
  }
});

router.post('/:userId/accept-friend', async (req, res) => {
  try {
    const currentUserId = req.userId;
    const { userId } = req.params;
    const friendship = await prisma.friendship.findFirst({
      where: { initiatorId: userId, receiverId: currentUserId, status: 'pending' },
    });
    if (!friendship) return res.status(404).json({ error: 'Friend request not found' });

    const updated = await prisma.friendship.update({
      where: { id: friendship.id },
      data: { status: 'accepted' },
    });
    res.status(200).json({ success: true, data: { friendship: updated } });
  } catch (error) {
    console.error('Accept friend error:', error);
    res.status(500).json({ error: 'Failed to accept friend request' });
  }
});

router.delete('/:userId/reject-friend', async (req, res) => {
  try {
    const currentUserId = req.userId;
    const { userId } = req.params;
    const friendship = await prisma.friendship.findFirst({
      where: {
        OR: [
          { initiatorId: userId, receiverId: currentUserId, status: 'pending' },
          { initiatorId: currentUserId, receiverId: userId, status: 'pending' },
        ],
      },
    });
    if (!friendship) return res.status(404).json({ error: 'Friend request not found' });
    await prisma.friendship.delete({ where: { id: friendship.id } });
    res.status(200).json({ success: true, message: 'Friend request rejected' });
  } catch (error) {
    console.error('Reject friend error:', error);
    res.status(500).json({ error: 'Failed to reject friend request' });
  }
});

router.delete('/:userId/friend', async (req, res) => {
  try {
    const currentUserId = req.userId;
    const { userId } = req.params;
    const friendship = await prisma.friendship.findFirst({
      where: {
        OR: [
          { initiatorId: currentUserId, receiverId: userId, status: 'accepted' },
          { initiatorId: userId, receiverId: currentUserId, status: 'accepted' },
        ],
      },
    });
    if (!friendship) return res.status(404).json({ error: 'Friendship not found' });
    await prisma.friendship.delete({ where: { id: friendship.id } });
    res.status(200).json({ success: true, message: 'Friend removed' });
  } catch (error) {
    console.error('Remove friend error:', error);
    res.status(500).json({ error: 'Failed to remove friend' });
  }
});

router.post('/:userId/block', async (req, res) => {
  try {
    const currentUserId = req.userId;
    const { userId } = req.params;
    if (currentUserId === userId) return res.status(400).json({ error: 'You cannot block yourself' });

    const targetUser = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    const existing = await prisma.blockedUser.findFirst({
      where: { blockerId: currentUserId, blockedId: userId },
    });
    if (existing) return res.status(409).json({ error: 'User is already blocked' });

    const blocked = await prisma.blockedUser.create({
      data: { blockerId: currentUserId, blockedId: userId },
    });
    await prisma.friendship.deleteMany({
      where: {
        OR: [
          { initiatorId: currentUserId, receiverId: userId },
          { initiatorId: userId, receiverId: currentUserId },
        ],
      },
    });
    res.status(201).json({ success: true, data: { blocked } });
  } catch (error) {
    console.error('Block user error:', error);
    res.status(500).json({ error: 'Failed to block user' });
  }
});

router.delete('/:userId/block', async (req, res) => {
  try {
    const currentUserId = req.userId;
    const { userId } = req.params;
    const blocked = await prisma.blockedUser.findFirst({
      where: { blockerId: currentUserId, blockedId: userId },
    });
    if (!blocked) return res.status(404).json({ error: 'User is not blocked' });
    await prisma.blockedUser.delete({ where: { id: blocked.id } });
    res.status(200).json({ success: true, message: 'User unblocked' });
  } catch (error) {
    console.error('Unblock user error:', error);
    res.status(500).json({ error: 'Failed to unblock user' });
  }
});

export default router;
