import express from 'express';
import { prisma } from './server.js';
import { authenticateToken, checkNotBlocked, requireFriendship } from './jwt.js';

const router = express.Router();

// ============================================================================
// GET USER PROFILE ENDPOINT
// ============================================================================

router.get('/:userId', authenticateToken, checkNotBlocked, async (req, res) => {
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
        _count: {
          select: {
            friendships: {
              where: { status: 'accepted', initiatorId: userId }
            },
            friendshipRequests: {
              where: { status: 'accepted', receiverId: userId }
            },
            sentConversations: true,
            groupMemberships: true,
            messages: true
          }
        }
      }
    });

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    let friendship = null;
    let isCurrentUser = false;

    if (userId === currentUserId) {
      isCurrentUser = true;
    } else {
      friendship = await prisma.friendship.findFirst({
        where: {
          OR: [
            { initiatorId: currentUserId, receiverId: userId },
            { initiatorId: userId, receiverId: currentUserId }
          ]
        }
      });
    }

    const totalFriends = user._count.friendships + user._count.friendshipRequests;

    const profileData = {
      ...user,
      _count: {
        ...user._count,
        friends: totalFriends
      }
    };

    delete profileData._count.friendships;
    delete profileData._count.friendshipRequests;

    res.status(200).json({
      success: true,
      data: {
        profile: profileData,
        isCurrentUser,
        friendship: friendship ? {
          id: friendship.id,
          status: friendship.status,
          initiator: friendship.initiatorId === currentUserId
        } : null
      }
    });
  } catch (error) {
    console.error('Get user profile error:', error);

    res.status(500).json({
      error: 'Failed to fetch user profile',
      code: 'FETCH_ERROR'
    });
  }
});

// ============================================================================
// UPDATE USER PROFILE ENDPOINT
// ============================================================================

router.patch('/me/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { displayName, bio, isPrivate } = req.body;

    const updateData = {};

    if (displayName !== undefined) {
      if (displayName.length > 100) {
        return res.status(400).json({
          error: 'Display name must be less than 100 characters',
          code: 'INVALID_INPUT'
        });
      }
      updateData.displayName = displayName;
    }

    if (bio !== undefined) {
      if (bio.length > 500) {
        return res.status(400).json({
          error: 'Bio must be less than 500 characters',
          code: 'INVALID_INPUT'
        });
      }
      updateData.bio = bio;
    }

    if (isPrivate !== undefined) {
      updateData.isPrivate = isPrivate;
    }

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
        createdAt: true
      }
    });

    res.status(200).json({
      success: true,
      data: {
        user: updatedUser
      }
    });
  } catch (error) {
    console.error('Update profile error:', error);

    res.status(500).json({
      error: 'Failed to update profile',
      code: 'UPDATE_ERROR'
    });
  }
});

// ============================================================================
// SEARCH USERS ENDPOINT
// ============================================================================

router.get('/search/query', authenticateToken, async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;
    const currentUserId = req.userId;

    if (!q || q.trim().length === 0) {
      return res.status(400).json({
        error: 'Search query is required',
        code: 'MISSING_QUERY'
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
              { email: { contains: searchTerm, mode: 'insensitive' } }
            ]
          },
          {
            id: { not: currentUserId }
          }
        ]
      },
      select: {
        id: true,
        username: true,
        displayName: true,
        avatar: true,
        bio: true,
        isVerified: true,
        isOnline: true
      },
      take: maxLimit,
      orderBy: [
        { isVerified: 'desc' },
        { lastActive: 'desc' }
      ]
    });

    res.status(200).json({
      success: true,
      data: {
        users,
        count: users.length
      }
    });
  } catch (error) {
    console.error('Search users error:', error);

    res.status(500).json({
      error: 'Search failed',
      code: 'SEARCH_ERROR'
    });
  }
});

// ============================================================================
// GET USER STATISTICS ENDPOINT
// ============================================================================

router.get('/:userId/stats', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        _count: {
          select: {
            messages: true,
            sentConversations: true,
            groupMemberships: true,
            friendships: { where: { status: 'accepted' } },
            friendshipRequests: { where: { status: 'accepted' } },
            notifications: { where: { read: false } }
          }
        }
      }
    });

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    const stats = {
      totalMessages: user._count.messages,
      totalConversations: user._count.sentConversations,
      totalGroups: user._count.groupMemberships,
      totalFriends: user._count.friendships + user._count.friendshipRequests,
      unreadNotifications: user._count.notifications
    };

    res.status(200).json({
      success: true,
      data: {
        userId: user.id,
        username: user.username,
        stats
      }
    });
  } catch (error) {
    console.error('Get user stats error:', error);

    res.status(500).json({
      error: 'Failed to fetch statistics',
      code: 'FETCH_ERROR'
    });
  }
});

// ============================================================================
// SEND FRIEND REQUEST ENDPOINT
// ============================================================================

router.post('/:userId/friend-request', authenticateToken, async (req, res) => {
  try {
    const currentUserId = req.userId;
    const { userId } = req.params;

    if (currentUserId === userId) {
      return res.status(400).json({
        error: 'You cannot send a friend request to yourself',
        code: 'SELF_REQUEST'
      });
    }

    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true }
    });

    if (!targetUser) {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    const existingFriendship = await prisma.friendship.findFirst({
      where: {
        OR: [
          { initiatorId: currentUserId, receiverId: userId },
          { initiatorId: userId, receiverId: currentUserId }
        ]
      }
    });

    if (existingFriendship) {
      return res.status(409).json({
        error: 'Friendship request already exists',
        code: 'FRIENDSHIP_EXISTS',
        data: { status: existingFriendship.status }
      });
    }

    const friendship = await prisma.friendship.create({
      data: {
        initiatorId: currentUserId,
        receiverId: userId,
        status: 'pending'
      }
    });

    await prisma.notification.create({
      data: {
        userId,
        type: 'friend_request',
        title: 'Friend Request',
        content: 'You have a new friend request',
        link: `/user/${currentUserId}`
      }
    });

    res.status(201).json({
      success: true,
      data: {
        friendship
      }
    });
  } catch (error) {
    console.error('Send friend request error:', error);

    res.status(500).json({
      error: 'Failed to send friend request',
      code: 'REQUEST_ERROR'
    });
  }
});

// ============================================================================
// ACCEPT FRIEND REQUEST ENDPOINT
// ============================================================================

router.post('/:userId/accept-friend', authenticateToken, async (req, res) => {
  try {
    const currentUserId = req.userId;
    const { userId } = req.params;

    const friendship = await prisma.friendship.findFirst({
      where: {
        initiatorId: userId,
        receiverId: currentUserId,
        status: 'pending'
      }
    });

    if (!friendship) {
      return res.status(404).json({
        error: 'Friend request not found',
        code: 'NOT_FOUND'
      });
    }

    const updatedFriendship = await prisma.friendship.update({
      where: { id: friendship.id },
      data: { status: 'accepted' }
    });

    await prisma.notification.create({
      data: {
        userId,
        type: 'friend_accepted',
        title: 'Friend Request Accepted',
        content: 'Your friend request was accepted',
        link: `/user/${currentUserId}`
      }
    });

    res.status(200).json({
      success: true,
      data: {
        friendship: updatedFriendship
      }
    });
  } catch (error) {
    console.error('Accept friend request error:', error);

    res.status(500).json({
      error: 'Failed to accept friend request',
      code: 'ACCEPT_ERROR'
    });
  }
});

// ============================================================================
// REJECT FRIEND REQUEST ENDPOINT
// ============================================================================

router.delete('/:userId/reject-friend', authenticateToken, async (req, res) => {
  try {
    const currentUserId = req.userId;
    const { userId } = req.params;

    const friendship = await prisma.friendship.findFirst({
      where: {
        OR: [
          { initiatorId: userId, receiverId: currentUserId, status: 'pending' },
          { initiatorId: currentUserId, receiverId: userId, status: 'pending' }
        ]
      }
    });

    if (!friendship) {
      return res.status(404).json({
        error: 'Friend request not found',
        code: 'NOT_FOUND'
      });
    }

    await prisma.friendship.delete({
      where: { id: friendship.id }
    });

    res.status(200).json({
      success: true,
      message: 'Friend request rejected'
    });
  } catch (error) {
    console.error('Reject friend request error:', error);

    res.status(500).json({
      error: 'Failed to reject friend request',
      code: 'REJECT_ERROR'
    });
  }
});

// ============================================================================
// REMOVE FRIEND ENDPOINT
// ============================================================================

router.delete('/:userId/friend', authenticateToken, async (req, res) => {
  try {
    const currentUserId = req.userId;
    const { userId } = req.params;

    const friendship = await prisma.friendship.findFirst({
      where: {
        OR: [
          { initiatorId: currentUserId, receiverId: userId, status: 'accepted' },
          { initiatorId: userId, receiverId: currentUserId, status: 'accepted' }
        ]
      }
    });

    if (!friendship) {
      return res.status(404).json({
        error: 'Friendship not found',
        code: 'NOT_FOUND'
      });
    }

    await prisma.friendship.delete({
      where: { id: friendship.id }
    });

    res.status(200).json({
      success: true,
      message: 'Friend removed'
    });
  } catch (error) {
    console.error('Remove friend error:', error);

    res.status(500).json({
      error: 'Failed to remove friend',
      code: 'REMOVE_ERROR'
    });
  }
});

// ============================================================================
// BLOCK USER ENDPOINT
// ============================================================================

router.post('/:userId/block', authenticateToken, async (req, res) => {
  try {
    const currentUserId = req.userId;
    const { userId } = req.params;

    if (currentUserId === userId) {
      return res.status(400).json({
        error: 'You cannot block yourself',
        code: 'SELF_BLOCK'
      });
    }

    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true }
    });

    if (!targetUser) {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    const existingBlock = await prisma.blockedUser.findFirst({
      where: {
        blockerId: currentUserId,
        blockedId: userId
      }
    });

    if (existingBlock) {
      return res.status(409).json({
        error: 'User is already blocked',
        code: 'ALREADY_BLOCKED'
      });
    }

    const blocked = await prisma.blockedUser.create({
      data: {
        blockerId: currentUserId,
        blockedId: userId
      }
    });

    await prisma.friendship.deleteMany({
      where: {
        OR: [
          { initiatorId: currentUserId, receiverId: userId },
          { initiatorId: userId, receiverId: currentUserId }
        ]
      }
    });

    res.status(201).json({
      success: true,
      data: { blocked }
    });
  } catch (error) {
    console.error('Block user error:', error);

    res.status(500).json({
      error: 'Failed to block user',
      code: 'BLOCK_ERROR'
    });
  }
});

// ============================================================================
// UNBLOCK USER ENDPOINT
// ============================================================================

router.delete('/:userId/block', authenticateToken, async (req, res) => {
  try {
    const currentUserId = req.userId;
    const { userId } = req.params;

    const blocked = await prisma.blockedUser.findFirst({
      where: {
        blockerId: currentUserId,
        blockedId: userId
      }
    });

    if (!blocked) {
      return res.status(404).json({
        error: 'User is not blocked',
        code: 'NOT_BLOCKED'
      });
    }

    await prisma.blockedUser.delete({
      where: { id: blocked.id }
    });

    res.status(200).json({
      success: true,
      message: 'User unblocked'
    });
  } catch (error) {
    console.error('Unblock user error:', error);

    res.status(500).json({
      error: 'Failed to unblock user',
      code: 'UNBLOCK_ERROR'
    });
  }
});

// ============================================================================
// GET BLOCKED USERS ENDPOINT
// ============================================================================

router.get('/me/blocked', authenticateToken, async (req, res) => {
  try {
    const currentUserId = req.userId;

    const blockedUsers = await prisma.blockedUser.findMany({
      where: { blockerId: currentUserId },
      include: {
        blocked: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatar: true,
            isVerified: true,
            isOnline: true
          }
        }
      }
    });

    res.status(200).json({
      success: true,
      data: {
        blockedUsers: blockedUsers.map(b => ({
          blockId: b.id,
          user: b.blocked,
          blockedAt: b.createdAt
        })),
        count: blockedUsers.length
      }
    });
  } catch (error) {
    console.error('Get blocked users error:', error);

    res.status(500).json({
      error: 'Failed to fetch blocked users',
      code: 'FETCH_ERROR'
    });
  }
});

export default router;
