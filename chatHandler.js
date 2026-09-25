export const initChatHandler = (io, prismaClient) => {
  io.on('connection', (socket) => {
    const userId = socket.userId;

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
        const { conversationId, groupId, content, replyToId } = data;

        if (!content || content.trim().length === 0) {
          socket.emit('error', { message: 'Message content is required' });
          return;
        }
        if (content.length > 5000) {
          socket.emit('error', { message: 'Message is too long' });
          return;
        }

        let message;

        if (conversationId) {
          const conversation = await prismaClient.conversation.findUnique({
            where: { id: conversationId },
          });

          if (
            !conversation ||
            (conversation.user1Id !== userId && conversation.user2Id !== userId)
          ) {
            socket.emit('error', { message: 'No access to this conversation' });
            return;
          }

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
              lastMessage: content.substring(0, 100),
              lastMessageAt: new Date(),
              lastMessageBy: userId,
            },
          });

          io.to(`conversation:${conversationId}`).emit('message:new', {
            message,
            conversationId,
          });
        } else if (groupId) {
          const group = await prismaClient.group.findUnique({
            where: { id: groupId },
            include: { members: true },
          });

          if (!group || !group.members.some((m) => m.userId === userId)) {
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

          io.to(`group:${groupId}`).emit('message:new', {
            message,
            groupId,
          });
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

    // Soft-delete
    socket.on('delete:message', async (data) => {
      try {
        const { messageId } = data;

        const message = await prismaClient.message.findUnique({
          where: { id: messageId },
        });

        if (!message || message.isDeleted) {
          socket.emit('error', { message: 'Message not found' });
          return;
        }
        if (message.senderId !== userId) {
          socket.emit('error', { message: 'You can only delete your own messages' });
          return;
        }

        await prismaClient.message.update({
          where: { id: messageId },
          data: {
            isDeleted: true,
            deletedAt: new Date(),
            content: '',
          },
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

    socket.on('message:react', async (data) => {
      try {
        const { messageId, emoji } = data;

        if (!emoji) {
          socket.emit('error', { message: 'Emoji is required' });
          return;
        }

        const message = await prismaClient.message.findUnique({
          where: { id: messageId },
        });

        if (!message || message.isDeleted) {
          socket.emit('error', { message: 'Message not found' });
          return;
        }

        const existingReaction = await prismaClient.reaction.findUnique({
          where: {
            messageId_userId_emoji: { messageId, userId, emoji },
          },
        });

        if (existingReaction) {
          await prismaClient.reaction.delete({
            where: {
              messageId_userId_emoji: { messageId, userId, emoji },
            },
          });
        } else {
          await prismaClient.reaction.create({
            data: { messageId, userId, emoji },
          });
        }

        const updatedMessage = await prismaClient.message.findUnique({
          where: { id: messageId },
          include: {
            reactions: {
              include: {
                user: { select: { id: true, displayName: true } },
              },
            },
          },
        });

        const roomId = message.conversationId
          ? `conversation:${message.conversationId}`
          : `group:${message.groupId}`;

        io.to(roomId).emit('message:reaction', {
          message: updatedMessage,
          messageId,
        });
      } catch (error) {
        console.error('React to message error:', error);
        socket.emit('error', { message: 'Failed to react to message' });
      }
    });

    socket.on('join:group', async (groupId) => {
      try {
        const group = await prismaClient.group.findUnique({
          where: { id: groupId },
          include: { members: true },
        });

        if (!group) {
          socket.emit('error', { message: 'Group not found' });
          return;
        }

        if (!group.members.some((m) => m.userId === userId)) {
          socket.emit('error', { message: 'No access to this group' });
          return;
        }

        socket.join(`group:${groupId}`);
        socket.emit('joined:group', { groupId, message: 'Joined group' });

        socket.to(`group:${groupId}`).emit('group:member-joined', {
          groupId,
          userId,
        });
      } catch (error) {
        console.error('Join group error:', error);
        socket.emit('error', { message: 'Failed to join group' });
      }
    });

    socket.on('leave:group', (groupId) => {
      socket.leave(`group:${groupId}`);
      socket.emit('left:group', { groupId });
      socket.to(`group:${groupId}`).emit('group:member-left', {
        groupId,
        userId,
      });
    });

    socket.on('disconnect', async () => {
      try {
        await prismaClient.user.update({
          where: { id: userId },
          data: {
            isOnline: false,
            lastSeen: new Date(),
          },
        });
      } catch (error) {
        console.error('Disconnect error:', error);
      }
    });
  });
};
