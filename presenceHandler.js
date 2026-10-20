/**
 * Presence + typing — mostly in-memory.
 * Online/offline DB writes are throttled so hundreds of connects
 * do not hammer Postgres.
 */

import { shouldWrite, rateLimit } from './scale.js';

export const initPresenceHandler = (io, prismaClient) => {
  io.on('connection', (socket) => {
    const userId = socket.userId;
    const userEmail = socket.userEmail;
    const username = socket.username;

    socket.join(`user:${userId}`);

    const emitToJoinedRooms = (event, payload) => {
      for (const room of socket.rooms) {
        if (room === socket.id) continue;
        if (room.startsWith('user:')) continue;
        io.to(room).emit(event, payload);
      }
    };

    const markOnline = () => {
      if (!shouldWrite(`online:${userId}`, 45_000)) return;
      prismaClient.user
        .update({
          where: { id: userId },
          data: { isOnline: true, lastActive: new Date() },
        })
        .catch(() => {});
    };

    socket.on('user:online', () => {
      markOnline();
      emitToJoinedRooms('user:online', {
        userId,
        username,
        timestamp: new Date(),
      });
    });

    socket.on('typing:start', (data = {}) => {
      try {
        const r = rateLimit(`typing:${userId}`, { limit: 8, windowMs: 5_000 });
        if (!r.ok) return;

        const { conversationId, groupId } = data;
        if (!conversationId && !groupId) return;
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
            onlineUsers = [conversation.user1, conversation.user2].filter((u) => u?.isOnline);
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
            onlineUsers = group.members.map((m) => m.user).filter((u) => u?.isOnline);
          }
        }

        socket.emit('active:users', {
          users: onlineUsers,
          conversationId,
          groupId,
        });
      } catch (error) {
        console.error('Get active users error:', error);
      }
    });

    socket.on('get:typing-users', (data = {}) => {
      socket.emit('typing:users', {
        users: [],
        conversationId: data.conversationId,
        groupId: data.groupId,
      });
    });

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

    socket.on('user:status-update', async (data = {}) => {
      try {
        const { status } = data;
        const validStatuses = ['online', 'idle', 'away', 'offline'];
        if (!validStatuses.includes(status)) return;

        if (status !== 'offline') {
          if (shouldWrite(`online:${userId}`, 45_000)) {
            await prismaClient.user.update({
              where: { id: userId },
              data: { isOnline: true, lastActive: new Date() },
            });
          }
        } else if (shouldWrite(`offline:${userId}`, 30_000)) {
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
      }
    });

    socket.emit('connection:established', {
      userId,
      username,
      userEmail,
      timestamp: new Date(),
    });

    markOnline();

    socket.on('disconnect', async () => {
      try {
        const room = io.sockets.adapter.rooms.get(`user:${userId}`);
        if (room && room.size > 0) return;

        if (shouldWrite(`offline:${userId}`, 15_000)) {
          await prismaClient.user.update({
            where: { id: userId },
            data: { isOnline: false, lastSeen: new Date() },
          });
        }

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
