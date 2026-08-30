import { prisma } from './server.js';

export const initPresenceHandler = (io, prismaClient) => {
  io.on('connection', (socket) => {
    const userId = socket.userId;
    const userEmail = socket.userEmail;
    const username = socket.username;

    // ========================================================================
    // USER ONLINE
    // ========================================================================

    socket.on('user:online', async () => {
      try {
        await prismaClient.user.update({
          where: { id: userId },
          data: {
            isOnline: true,
            lastActive: new Date()
          }
        });

        io.emit('user:online', {
          userId,
          username,
          timestamp: new Date()
        });
      } catch (error) {
        console.error('User online error:', error);
      }
    });

    // ========================================================================
    // TYPING START
    // ========================================================================

    socket.on('typing:start', async (data) => {
      try {
        const { conversationId, groupId } = data;

        if (!conversationId && !groupId) {
          socket.emit('error', { message: 'Conversation or group ID is required' });
          return;
        }

        const roomId = conversationId ? `conversation:${conversationId}` : `group:${groupId}`;

        const typingStatus = await prismaClient.typingStatus.create({
          data: {
            userId,
            conversationId: conversationId || null,
            groupId: groupId || null,
            expiresAt: new Date(Date.now() + 30000)
          }
        });

        io.to(roomId).emit('user:typing', {
          userId,
          username,
          conversationId,
          groupId,
          typingStatusId: typingStatus.id
        });

        setTimeout(async () => {
          try {
            await prismaClient.typingStatus.deleteMany({
              where: {
                userId,
                OR: [
                  { conversationId },
                  { groupId }
                ]
              }
            });
          } catch (error) {
            console.error('Delete typing status error:', error);
          }
        }, 30000);
      } catch (error) {
        console.error('Typing start error:', error);
      }
    });

    // ========================================================================
    // TYPING STOP
    // ========================================================================

    socket.on('typing:stop', async (data) => {
      try {
        const { conversationId, groupId } = data;

        if (!conversationId && !groupId) {
          return;
        }

        await prismaClient.typingStatus.deleteMany({
          where: {
            userId,
            OR: [
              { conversationId: conversationId || undefined },
              { groupId: groupId || undefined }
            ]
          }
        });

        const roomId = conversationId ? `conversation:${conversationId}` : `group:${groupId}`;

        io.to(roomId).emit('user:stopped-typing', {
          userId,
          conversationId,
          groupId
        });
      } catch (error) {
        console.error('Typing stop error:', error);
      }
    });

    // ========================================================================
    // GET ACTIVE USERS IN CONVERSATION
    // ========================================================================

    socket.on('get:active-users', async (data) => {
      try {
        const { conversationId, groupId } = data;

        let onlineUsers = [];

        if (conversationId) {
          const conversation = await prismaClient.conversation.findUnique({
            where: { id: conversationId },
            include: {
              user1: { select: { id: true, username: true, displayName: true, isOnline: true } },
              user2: { select: { id: true, username: true, displayName: true, isOnline: true } }
            }
          });

          if (conversation) {
            onlineUsers = [conversation.user1, conversation.user2].filter(u => u.isOnline);
          }
        } else if (groupId) {
          const group = await prismaClient.group.findUnique({
            where: { id: groupId },
            include: {
              members: {
                include: {
                  user: {
                    select: { id: true, username: true, displayName: true, isOnline: true }
                  }
                }
              }
            }
          });

          if (group) {
            onlineUsers = group.members
              .map(m => m.user)
              .filter(u => u.isOnline);
          }
        }

        socket.emit('active:users', {
          users: onlineUsers,
          conversationId,
          groupId
        });
      } catch (error) {
        console.error('Get active users error:', error);
        socket.emit('error', { message: 'Failed to fetch active users' });
      }
    });

    // ========================================================================
    // GET TYPING USERS
    // ========================================================================

    socket.on('get:typing-users', async (data) => {
      try {
        const { conversationId, groupId } = data;

        const typingStatuses = await prismaClient.typingStatus.findMany({
          where: {
            AND: [
              { userId: { not: userId } },
              {
                OR: [
                  { conversationId: conversationId || undefined },
                  { groupId: groupId || undefined }
                ]
              }
            ]
          },
          include: {
            user: {
              select: { id: true, username: true, displayName: true }
            }
          }
        });

        const typingUsers = typingStatuses.map(ts => ({
          userId: ts.user.id,
          username: ts.user.username,
          displayName: ts.user.displayName
        }));

        socket.emit('typing:users', {
          users: typingUsers,
          conversationId,
          groupId
        });
      } catch (error) {
        console.error('Get typing users error:', error);
      }
    });

    // ========================================================================
    // MESSAGE READ RECEIPT
    // ========================================================================

    socket.on('message:read', async (data) => {
      try {
        const { messageId, conversationId, groupId } = data;

        const roomId = conversationId ? `conversation:${conversationId}` : `group:${groupId}`;

        io.to(roomId).emit('message:read-receipt', {
          messageId,
          userId,
          username,
          timestamp: new Date()
        });
      } catch (error) {
        console.error('Message read error:', error);
      }
    });

    // ========================================================================
    // USER STATUS UPDATE
    // ========================================================================

    socket.on('user:status-update', async (data) => {
      try {
        const { status } = data;

        const validStatuses = ['online', 'idle', 'away', 'offline'];
        if (!validStatuses.includes(status)) {
          socket.emit('error', { message: 'Invalid status' });
          return;
        }

        if (status !== 'offline') {
          await prismaClient.user.update({
            where: { id: userId },
            data: {
              isOnline: true,
              lastActive: new Date()
            }
          });
        } else {
          await prismaClient.user.update({
            where: { id: userId },
            data: {
              isOnline: false,
              lastSeen: new Date()
            }
          });
        }

        io.emit('user:status-changed', {
          userId,
          username,
          status,
          timestamp: new Date()
        });
      } catch (error) {
        console.error('Status update error:', error);
        socket.emit('error', { message: 'Failed to update status' });
      }
    });

    // ========================================================================
    // INITIAL PRESENCE
    // ========================================================================

    socket.emit('connection:established', {
      userId,
      username,
      userEmail,
      timestamp: new Date()
    });

    // Broadcast user came online
    io.emit('user:online', {
      userId,
      username,
      timestamp: new Date()
    });

    // ========================================================================
    // DISCONNECT (cleanup presence)
    // ========================================================================

    socket.on('disconnect', async () => {
      try {
        await prismaClient.user.update({
          where: { id: userId },
          data: {
            isOnline: false,
            lastSeen: new Date()
          }
        });

        await prismaClient.typingStatus.deleteMany({
          where: { userId }
        });

        io.emit('user:offline', {
          userId,
          username,
          timestamp: new Date()
        });
      } catch (error) {
        console.error('Disconnect cleanup error:', error);
      }
    });
  });
};
