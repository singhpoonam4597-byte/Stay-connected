import { rateLimit } from './scale.js';
import { notifyNewMessage } from './notifications.js';

export const initChatHandler = (io, prismaClient) => {
  io.on('connection', (socket) => {
    const userId = socket.userId;
    if (userId) {
      socket.join(`user:${userId}`);
    }

    socket.on('join:conversation', async (conversationId) => {
      try {
        const conversation = await prismaClient.conversation.findUnique({
          where: { id: conversationId },
        });

        if (!conversation) {
          socket.emit('error', { message: 'Conversation not found' });
          return;
        }

        if (conversation.user1Id !== userId && conversation.user2Id !== userId) {
          socket.emit('error', { message: 'No access to this conversation' });
          return;
        }

        socket.join(`conversation:${conversationId}`);
        socket.emit('joined:conversation', {
          conversationId,
          message: 'Joined conversation',
        });
      } catch (error) {
        console.error('Join conversation error:', error);
        socket.emit('error', { message: 'Failed to join conversation' });
      }
    });

    socket.on('leave:conversation', (conversationId) => {
      socket.leave(`conversation:${conversationId}`);
      socket.emit('left:conversation', { conversationId });
    });

    socket.on('send:message', async (data) => {
      try {
        const rl = rateLimit(`socket-msg:${userId}`, { limit: 40, windowMs: 60_000 });
        if (!rl.ok) {
          socket.emit('error', { message: 'Sending too fast' });
          return;
        }

        const { conversationId, groupId, content, replyToId } = data;

        if (!content || !String(content).trim()) {
          socket.emit('error', { message: 'Message content is required' });
          return;
        }

        if (!conversationId && !groupId) {
          socket.emit('error', { message: 'Conversation or group required' });
          return;
        }

        let message;

        if (conversationId) {
          const conversation = await prismaClient.conversation.findUnique({
            where: { id: conversationId },
          });

          if (!conversation) {
            socket.emit('error', { message: 'Conversation not found' });
            return;
          }
          if (conversation.user1Id !== userId && conversation.user2Id !== userId) {
            socket.emit('error', { message: 'No access to this conversation' });
            return;
          }

          const otherId =
            conversation.user1Id === userId ? conversation.user2Id : conversation.user1Id;

          message = await prismaClient.message.create({
            data: {
              content: content.trim(),
              senderId: userId,
              conversationId,
              replyToId: replyToId || null,
            },
            include: {
              sender: {
                select: { id: true, username: true, displayName: true, avatar: true },
              },
              replyTo: {
                select: {
                  id: true,
                  content: true,
                  isDeleted: true,
                  sender: { select: { displayName: true } },
                },
              },
            },
          });

          await prismaClient.conversation.update({
            where: { id: conversationId },
            data: {
              lastMessage: content.trim().substring(0, 100),
              lastMessageAt: new Date(),
              lastMessageBy: userId,
            },
          });

          const payload = { message, conversationId };
          io.to(`conversation:${conversationId}`).emit('message:new', payload);
          io.to(`user:${userId}`).emit('message:new', payload);
          if (otherId) {
            io.to(`user:${otherId}`).emit('message:new', payload);
            const sName =
              message.sender?.displayName ||
              message.sender?.username ||
              'Someone';
            notifyNewMessage(prismaClient, io, {
              recipientId: otherId,
              senderId: userId,
              senderName: sName,
              content: message.content,
              conversationId,
            }).catch(() => {});
          }
        } else if (groupId) {
          const group = await prismaClient.group.findUnique({
            where: { id: groupId },
            include: { members: true },
          });

          if (!group) {
            socket.emit('error', { message: 'Group not found' });
            return;
          }
          const isMember = (group.members || []).some((m) => m.userId === userId);
          if (!isMember) {
            socket.emit('error', { message: 'No access to this group' });
            return;
          }

          message = await prismaClient.message.create({
            data: {
              content: content.trim(),
              senderId: userId,
              groupId,
              replyToId: replyToId || null,
            },
            include: {
              sender: {
                select: { id: true, username: true, displayName: true, avatar: true },
              },
              replyTo: {
                select: {
                  id: true,
                  content: true,
                  isDeleted: true,
                  sender: { select: { displayName: true } },
                },
              },
            },
          });

          await prismaClient.group.update({
            where: { id: groupId },
            data: { updatedAt: new Date() },
          });

          const payload = { message, groupId };
          io.to(`group:${groupId}`).emit('message:new', payload);
          const sName =
            message.sender?.displayName ||
            message.sender?.username ||
            'Someone';
          for (const m of group.members || []) {
            if (m.userId) io.to(`user:${m.userId}`).emit('message:new', payload);
            if (m.userId && m.userId !== userId) {
              notifyNewMessage(prismaClient, io, {
                recipientId: m.userId,
                senderId: userId,
                senderName: sName,
                content: message.content,
                groupId,
              }).catch(() => {});
            }
          }
        }

        if (message) {
          socket.emit('message:sent', { messageId: message.id });
        }
      } catch (error) {
        console.error('Send message error:', error);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    socket.on('edit:message', async (data) => {
      try {
        const { messageId, content } = data;

        if (!content || content.trim().length === 0) {
          socket.emit('error', { message: 'Message content is required' });
          return;
        }

        const message = await prismaClient.message.findUnique({
          where: { id: messageId },
        });

        if (!message || message.isDeleted) {
          socket.emit('error', { message: 'Message not found' });
          return;
        }
        if (message.senderId !== userId) {
          socket.emit('error', { message: 'You can only edit your own messages' });
          return;
        }

        const updatedMessage = await prismaClient.message.update({
          where: { id: messageId },
          data: {
            content: content.trim(),
            isEdited: true,
            editedAt: new Date(),
          },
          include: {
            sender: {
              select: { id: true, username: true, displayName: true, avatar: true },
            },
          },
        });

        const roomId = message.conversationId
          ? `conversation:${message.conversationId}`
          : `group:${message.groupId}`;

        io.to(roomId).emit('message:edited', {
          message: updatedMessage,
          messageId,
        });
      } catch (error) {
        console.error('Edit message error:', error);
        socket.emit('error', { message: 'Failed to edit message' });
      }
    });

    socket.on('delete:message', async (data) => {
      try {
        const { messageId } = data;
        const message = await prismaClient.message.findUnique({
          where: { id: messageId },
        });

        if (!message) {
          socket.emit('error', { message: 'Message not found' });
          return;
        }
        if (message.senderId !== userId) {
          socket.emit('error', { message: 'You can only delete your own messages' });
          return;
        }

        await prismaClient.message.update({
          where: { id: messageId },
          data: { isDeleted: true, deletedAt: new Date(), content: '' },
        });

        const roomId = message.conversationId
          ? `conversation:${message.conversationId}`
          : `group:${message.groupId}`;

        io.to(roomId).emit('message:deleted', { messageId });
      } catch (error) {
        console.error('Delete message error:', error);
        socket.emit('error', { message: 'Failed to delete message' });
      }
    });

    socket.on('join:group', async (groupId) => {
      try {
        const member = await prismaClient.groupMember.findFirst({
          where: { groupId, userId },
        });
        if (!member) {
          socket.emit('error', { message: 'Not a group member' });
          return;
        }
        socket.join(`group:${groupId}`);
        socket.emit('joined:group', { groupId });
      } catch (error) {
        socket.emit('error', { message: 'Failed to join group' });
      }
    });

    socket.on('leave:group', (groupId) => {
      socket.leave(`group:${groupId}`);
    });
  });
};
