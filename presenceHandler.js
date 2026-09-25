/**
 * Presence + typing — in-memory only (no TypingStatus table writes).
 * Online/offline is scoped to rooms the socket has joined, not global io.emit.
 */

export const initPresenceHandler = (io, prismaClient) => {
  io.on('connection', (socket) => {
    const userId = socket.userId;
    const userEmail = socket.userEmail;
    const username = socket.username;

    // Private room for this user (for targeted events later)
    socket.join(`user:${userId}`);

    const emitToJoinedRooms = (event, payload) => {
      for (const room of socket.rooms) {
        if (room === socket.id) continue;
        if (room.startsWith('user:')) continue;
        io.to(room).emit(event, payload);
      }
    };

    // —— USER ONLINE ——
    socket.on('user:online', async () => {
      try {
        await prismaClient.user.update({
          where: { id: userId },
          data: { isOnline: true, lastActive: new Date() },
        });

        emitToJoinedRooms('user:online', {
          userId,
          username,
          timestamp: new Date(),
        });
      } catch (error) {
        console.error('User online error:', error);
      }
    });

    // —— TYPING START (no DB) ——
    socket.on('typing:start', (data = {}) => {
      try {
        const { conversationId, groupId } = data;
        if (!conversationId && !groupId) {
          socket.emit('error', { message: 'Conversation or group ID is required' });
          return;
        }
        const roomId = conversationId
          ? `conversation:${conversationId}`
          : `group:${groupId}`;

        socket.to(roomId).emit('user:typing', {
          userId,
          username,
          conversationId,
          groupId,
        });
      } catch (error) {
        console.error('Typing start error:', error);
      }
    });

    // —— TYPING STOP (no DB) ——
    socket.on('typing:stop', (data = {}) => {
      try {
        const { conversationId, groupId } = data;
        if (!conversationId && !groupId) return;

        const roomId = conversationId
          ? `conversation:${conversationId}`
          : `group:${groupId}`;

        socket.to(roomId).emit('user:stopped-typing', {
          userId,
          conversationId,
          groupId,
        });
      } catch (error) {
        console.error('Typing stop error:', error);
      }
    });

    // —— ACTIVE USERS IN ROOM ——
    socket.on('get:active-users', async (data = {}) => {
      try {
        const { conversationId, groupId } = data;
        let onlineUsers = [];

        if (conversationId) {
          const conversation = await prismaClient.conversation.findUnique({
            where: { id: conversationId },
            include: {
              user1: {
                select: { id: true, username: true, displayName: true, isOnline: true },
              },
              user2: {
                select: { id: true, username: true, displayName: true, isOnline: true },
              },
            },
          });
          if (conversation) {
            onlineUsers = [conversation.user1, conversation.user2].filter((u) => u.isOnline);
          }
        } else if (groupId) {
          const group = await prismaClient.group.findUnique({
            where: { id: groupId },
            include: {
              members: {
                include: {
                  user: {
                    select: { id: true, username: true, displayName: true, isOnline: true },
                  },
                },
              },
            },
          });
          if (group) {
            onlineUsers = group.members.map((m) => m.user).filter((u) => u.isOnline);
          }
        }

        socket.emit('active:users', {
          users: onlineUsers,
          conversationId,
          groupId,
        });
      } catch (error) {
        console.error('Get active users error:', error);
        socket.emit('error', { message: 'Failed to fetch active users' });
      }
    });

    // Typing users are ephemeral — clients track from socket events; empty list on query
    socket.on('get:typing-users', (data = {}) => {
      socket.emit('typing:users', {
        users: [],
        conversationId: data.conversationId,
        groupId: data.groupId,
      });
    });

    // —— READ RECEIPT (room-scoped) ——
    socket.on('message:read', (data = {}) => {
      try {
        const { messageId, conversationId, groupId } = data;
        const roomId = conversationId
          ? `conversation:${conversationId}`
          : groupId
            ? `group:${groupId}`
            : null;
        if (!roomId) return;

        socket.to(roomId).emit('message:read-receipt', {
          messageId,
          userId,
          username,
          timestamp: new Date(),
        });
      } catch (error) {
        console.error('Message read error:', error);
      }
    });

    // —— STATUS UPDATE (scoped) ——
    socket.on('user:status-update', async (data = {}) => {
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
            data: { isOnline: true, lastActive: new Date() },
          });
        } else {
          await prismaClient.user.update({
            where: { id: userId },
            data: { isOnline: false, lastSeen: new Date() },
          });
        }

        emitToJoinedRooms('user:status-changed', {
          userId,
          username,
          status,
          timestamp: new Date(),
        });
      } catch (error) {
        console.error('Status update error:', error);
        socket.emit('error', { message: 'Failed to update status' });
      }
    });

    socket.emit('connection:established', {
      userId,
      username,
      userEmail,
      timestamp: new Date(),
    });

    // Mark online in DB; do NOT global-broadcast
    prismaClient.user
      .update({
        where: { id: userId },
        data: { isOnline: true, lastActive: new Date() },
      })
      .catch(() => {});

    socket.on('disconnect', async () => {
      try {
        await prismaClient.user.update({
          where: { id: userId },
          data: { isOnline: false, lastSeen: new Date() },
        });

        emitToJoinedRooms('user:offline', {
          userId,
          username,
          timestamp: new Date(),
        });
      } catch (error) {
        console.error('Disconnect cleanup error:', error);
      }
    });
  });
};
