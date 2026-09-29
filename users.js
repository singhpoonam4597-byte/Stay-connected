import express from 'express';
import { prisma } from './server.js';

const router = express.Router();

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

async function getBlockedRelatedIds(currentUserId) {
  const rows = await prisma.blockedUser.findMany({
    where: {
      OR: [{ blockerId: currentUserId }, { blockedId: currentUserId }],
    },
    select: { blockerId: true, blockedId: true },
  });
  const ids = new Set();
  for (const r of rows) {
    if (r.blockerId !== currentUserId) ids.add(r.blockerId);
    if (r.blockedId !== currentUserId) ids.add(r.blockedId);
  }
  return [...ids];
}

const publicUserSelect = {
  id: true,
  username: true,
  displayName: true,
  avatar: true,
  avatarColor: true,
  bio: true,
  isVerified: true,
  isOnline: true,
};

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
    const excludedIds = await getBlockedRelatedIds(currentUserId);

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
          ...(excludedIds.length ? [{ id: { notIn: excludedIds } }] : []),
        ],
      },
      select: publicUserSelect,
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
            avatarColor: true,
            isVerified: true,
            isOnline: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
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
    const userId = req.user?.id || req.userId;
    const { displayName, bio, isPrivate, avatar, avatarColor } = req.body || {};
    const updateData = {};

    if (displayName !== undefined) {
      if (String(displayName).length > 100) {
        return res.status(400).json({
          error: 'Display name must be less than 100 characters',
        });
      }
      updateData.displayName = displayName;
    }
    if (bio !== undefined) {
      if (String(bio).length > 500) {
        return res.status(400).json({
          error: 'Bio must be less than 500 characters',
        });
      }
      updateData.bio = bio;
    }
    if (isPrivate !== undefined) updateData.isPrivate = !!isPrivate;

    // avatar: string URL, or null to clear (initials only)
    if (avatar !== undefined) {
      if (avatar === null || avatar === '') {
        updateData.avatar = null;
      } else if (typeof avatar === 'string' && avatar.length < 2000) {
        updateData.avatar = avatar;
      } else {
        return res.status(400).json({ error: 'Invalid avatar value' });
      }
    }

    // avatarColor: 0–11 index into Connect palette, or null
    if (avatarColor !== undefined) {
      if (avatarColor === null) {
        updateData.avatarColor = null;
      } else {
        const n = Number(avatarColor);
        if (!Number.isInteger(n) || n < 0 || n > 11) {
          return res.status(400).json({
            error: 'avatarColor must be an integer 0–11',
          });
        }
        updateData.avatarColor = n;
      }
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        username: true,
        displayName: true,
        avatar: true,
        avatarColor: true,
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
        avatarColor: true,
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

    const isCurrentUser = userId === currentUserId;

    res.status(200).json({
      success: true,
      data: {
        profile: user,
        isCurrentUser,
      },
    });
  } catch (error) {
    console.error('Get user profile error:', error);
    res.status(500).json({ error: 'Failed to fetch user profile', code: 'FETCH_ERROR' });
  }
});

router.post('/:userId/block', async (req, res) => {
  try {
    const currentUserId = req.userId;
    const { userId } = req.params;
    if (currentUserId === userId) {
      return res.status(400).json({ error: 'You cannot block yourself' });
    }

    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
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
