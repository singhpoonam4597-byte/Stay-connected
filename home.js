import express from 'express';

const userSelect = {
  id: true,
  username: true,
  displayName: true,
  avatar: true,
  avatarColor: true,
};

/**
 * Build the Home dashboard from existing, user-scoped CONNECT data.
 * Kept separate from Express so the aggregation can be tested without a database.
 */
export async function getHomeDashboardData(prisma, userId) {
  const [
    profile,
    recentConversations,
    activeConversationCount,
    recentMemberships,
    activeGroupCount,
    notifications,
    unreadNotificationCount,
    recentFiles,
    fileCount,
  ] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { ...userSelect, bio: true },
    }),
    prisma.conversation.findMany({
      where: {
        OR: [
          { user1Id: userId, user1ArchivedAt: null },
          { user2Id: userId, user2ArchivedAt: null },
        ],
      },
      include: {
        user1: { select: userSelect },
        user2: { select: userSelect },
      },
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
      take: 6,
    }),
    prisma.conversation.count({
      where: {
        OR: [
          { user1Id: userId, user1ArchivedAt: null },
          { user2Id: userId, user2ArchivedAt: null },
        ],
      },
    }),
    prisma.groupMember.findMany({
      where: { userId, archivedAt: null },
      include: {
        group: {
          select: {
            id: true,
            name: true,
            description: true,
            avatar: true,
            lastMessage: true,
            lastMessageAt: true,
            createdAt: true,
          },
        },
      },
      orderBy: { joinedAt: 'desc' },
      take: 5,
    }),
    prisma.groupMember.count({ where: { userId, archivedAt: null } }),
    prisma.notification.findMany({
      where: { userId },
      select: {
        id: true,
        type: true,
        title: true,
        content: true,
        link: true,
        read: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
    prisma.notification.count({ where: { userId, read: false } }),
    prisma.attachment.findMany({
      where: { uploadedBy: userId },
      select: {
        id: true,
        fileName: true,
        fileSize: true,
        fileType: true,
        mimeType: true,
        fileUrl: true,
        thumbnailUrl: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
    prisma.attachment.count({ where: { uploadedBy: userId } }),
  ]);

  const conversations = recentConversations.map((conversation) => ({
    id: conversation.id,
    contact: conversation.user1Id === userId ? conversation.user2 : conversation.user1,
    lastMessage: conversation.lastMessage,
    lastMessageAt: conversation.lastMessageAt,
    createdAt: conversation.createdAt,
  }));

  const recentGroups = recentMemberships
    .filter((membership) => membership.group)
    .map((membership) => ({
      ...membership.group,
      role: membership.role,
      joinedAt: membership.joinedAt,
    }));

  return {
    generatedAt: new Date().toISOString(),
    profile,
    summary: {
      activeConversations: activeConversationCount,
      activeGroups: activeGroupCount,
      unreadNotifications: unreadNotificationCount,
      uploadedFiles: fileCount,
    },
    recentConversations: conversations,
    recentGroups,
    notifications,
    recentFiles: recentFiles.map((file) => ({
      ...file,
      fileSize:
        typeof file.fileSize === 'bigint'
          ? Number(file.fileSize)
          : file.fileSize,
    })),
  };
}

export function createHomeRouter(prisma = null) {
  const router = express.Router();

  router.get('/dashboard', async (req, res) => {
    const userId = req.user?.id || req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    }

    try {
      const client = prisma || (await import('./prisma.js')).prisma;
      const dashboard = await getHomeDashboardData(client, userId);
      if (!dashboard.profile) {
        return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
      }
      return res.status(200).json({ success: true, data: dashboard });
    } catch (error) {
      console.error('Home dashboard error:', error);
      return res.status(500).json({
        error: 'Failed to load Home dashboard',
        code: 'HOME_DASHBOARD_ERROR',
      });
    }
  });

  return router;
}

export const homeRoutes = createHomeRouter();
export default homeRoutes;
