import express from 'express';
import { prisma } from './prisma.js';
import { authenticateToken } from './auth.js';

const router = express.Router();

const publicUserSelect = {
  id: true,
  username: true,
  displayName: true,
  avatar: true,
  avatarColor: true,
  bio: true,
  isVerified: true,
  isOnline: true,
  lastSeen: true,
  isPrivate: true,
};

async function getBlockedRelatedIds(userId) {
  if (!userId) return [];
  const rows = await prisma.blockedUser.findMany({
    where: {
      OR: [{ blockerId: userId }, { blockedId: userId }],
    },
    select: { blockerId: true, blockedId: true },
  });
  const ids = new Set();
  for (const r of rows) {
    if (r.blockerId !== userId) ids.add(r.blockerId);
    if (r.blockedId !== userId) ids.add(r.blockedId);
  }
  return [...ids];
}

/**
 * GET /api/discover/people?q=&limit=
 * Privacy-aware people discovery:
 * - excludes self + block relationships
 * - public users: username/displayName contains query
 * - private users: exact username match only
 */
router.get('/people', authenticateToken, async (req, res) => {
  try {
    const currentUserId = req.user?.id || req.userId;
    const { q, limit = 20 } = req.query;

    if (!q || String(q).trim().length === 0) {
      return res.status(400).json({
        error: 'Search query is required',
        code: 'MISSING_QUERY',
      });
    }

    const searchTerm = String(q).trim();
    const maxLimit = Math.min(parseInt(limit, 10) || 20, 50);
    const excludedIds = await getBlockedRelatedIds(currentUserId);

    const users = await prisma.user.findMany({
      where: {
        AND: [
          { id: { not: currentUserId } },
          ...(excludedIds.length ? [{ id: { notIn: excludedIds } }] : []),
          {
            OR: [
              {
                AND: [
                  { isPrivate: false },
                  {
                    OR: [
                      {
                        username: {
                          contains: searchTerm,
                          mode: 'insensitive',
                        },
                      },
                      {
                        displayName: {
                          contains: searchTerm,
                          mode: 'insensitive',
                        },
                      },
                    ],
                  },
                ],
              },
              {
                AND: [
                  { isPrivate: true },
                  {
                    username: {
                      equals: searchTerm,
                      mode: 'insensitive',
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      select: publicUserSelect,
      take: maxLimit,
      orderBy: [{ isVerified: 'desc' }, { lastSeen: 'desc' }],
    });

    // Respect showOnlineStatus — hide isOnline when they opted out
    const withPrivacy = await Promise.all(
      users.map(async (u) => {
        try {
          const s = await prisma.userSettings.findUnique({
            where: { userId: u.id },
            select: { showOnlineStatus: true },
          });
          if (s && s.showOnlineStatus === false) {
            return { ...u, isOnline: false, lastSeen: null };
          }
        } catch (_) {}
        return u;
      })
    );

    res.status(200).json({
      success: true,
      data: {
        people: withPrivacy,
        count: withPrivacy.length,
        query: searchTerm,
        module: 'discover',
      },
    });
  } catch (error) {
    console.error('Discover people error:', error);
    res.status(500).json({
      error: error?.message || 'Failed to discover people',
      code: 'DISCOVER_ERROR',
    });
  }
});

export default router;
