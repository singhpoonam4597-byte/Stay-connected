import express from 'express';
import { createHmac } from 'node:crypto';
import multer from 'multer';
import { rateLimit } from './scale.js';
import { prisma } from './prisma.js';
import { authenticateToken } from './auth.js';
import { notifyNewMessage } from './notifications.js';
import { translateText } from './ai.js';

const router = express.Router();
router.use(authenticateToken);

const LOCATION_DURATIONS = new Set([900, 3600, 28800]);
const DISAPPEARING_DURATIONS = new Set([0, 86400, 604800, 2592000]);

function translationRateLimit(req, res, next) {
  const userId = req.userId || req.user?.id || req.ip;
  const result = rateLimit(`one-to-one-translate:${userId}`, { limit: 20, windowMs: 60 * 60 * 1000 });
  if (!result.ok) return res.status(429).json({ error: 'Translation limit reached. Try again later.', code: 'TRANSLATION_RATE_LIMIT' });
  next();
}

function uploadRateLimit(req, res, next) {
  const userId = req.userId || req.user?.id || req.ip;
  const result = rateLimit(`one-to-one-upload:${userId}`, { limit: 40, windowMs: 15 * 60 * 1000 });
  if (!result.ok) return res.status(429).json({ error: 'Too many uploads. Try again later.', code: 'UPLOAD_RATE_LIMIT' });
  next();
}

async function getConversation(conversationId, userId) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, user1Id: true, user2Id: true, disappearingSeconds: true },
  });
  if (!conversation) return { error: 'Conversation not found', status: 404 };
  if (conversation.user1Id !== userId && conversation.user2Id !== userId) {
    return { error: 'You do not have access to this conversation', status: 403 };
  }
  return { conversation };
}

async function getDirectMessage(messageId, userId) {
  const message = await prisma.message.findFirst({
    where: { id: messageId, conversationId: { not: null } },
    include: { conversation: { select: { user1Id: true, user2Id: true } } },
  });
  if (!message) return { error: 'Message not found', status: 404 };
  if (message.conversation.user1Id !== userId && message.conversation.user2Id !== userId) {
    return { error: 'You do not have access to this message', status: 403 };
  }
  return { message };
}

function parseCallMeta(message) {
  if (!message || message.kind !== 'call') return null;
  if (message.callMeta && typeof message.callMeta === 'object') return message.callMeta;
  try {
    const raw = String(message.content || '');
    const jsonPart = raw.split('\n')[0].trim();
    const parsed = JSON.parse(jsonPart);
    if (parsed && typeof parsed === 'object' && parsed.v === 1) return parsed;
  } catch (_) {}
  return null;
}

function serializeMessage(message) {
  if (!message || typeof message !== 'object') return message;
  const callMeta = parseCallMeta(message);
  return {
    ...message,
    ...(callMeta ? { callMeta } : {}),
    attachments: Array.isArray(message.attachments)
      ? message.attachments.map((attachment) => ({
          ...attachment,
          fileSize: typeof attachment.fileSize === 'bigint' ? Number(attachment.fileSize) : attachment.fileSize,
        }))
      : message.attachments,
  };
}

function emitToConversation(io, conversationId, userIds, event, payload) {
  try {
    io?.to(`conversation:${conversationId}`).emit(event, payload);
    for (const id of userIds) if (id) io?.to(`user:${id}`).emit(event, payload);
  } catch (error) {
    console.error(`[one-to-one] ${event} broadcast failed:`, error?.message || error);
  }
}


const dmMimeTypes = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf', 'text/plain', 'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/x-m4a',
]);
const dmUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => dmMimeTypes.has(String(file.mimetype || '').toLowerCase().split(';')[0])
    ? cb(null, true)
    : cb(new Error('This file type is not supported')),
});

router.post('/upload', uploadRateLimit, (req, res, next) => {
  dmUpload.single('file')(req, res, (error) => {
    if (error) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'File must be under 5MB' : error.message || 'Upload failed' });
    next();
  });
}, async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    if (!req.file) return res.status(400).json({ error: 'Choose a file first' });
    const mimeType = String(req.file.mimetype || '').toLowerCase().split(';')[0];
    const fileUrl = `data:${mimeType};base64,${req.file.buffer.toString('base64')}`;
    const attachment = await prisma.attachment.create({
      data: {
        uploadedBy: userId,
        fileName: String(req.file.originalname || 'attachment').slice(0, 255),
        fileSize: BigInt(req.file.size || 0),
        fileType: String(mimeType.split('/')[1] || 'file').slice(0, 100),
        fileUrl,
        mimeType: mimeType.slice(0, 100),
      },
    });
    return res.status(201).json({ success: true, data: { attachment: {
      id: attachment.id, fileUrl: attachment.fileUrl, mimeType: attachment.mimeType,
      fileName: attachment.fileName, fileSize: Number(attachment.fileSize),
    } } });
  } catch (error) {
    console.error('[one-to-one] upload:', error?.message || error);
    return res.status(500).json({ error: 'Could not upload this file' });
  }
});

router.get('/conversations/:conversationId/messages', async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const access = await getConversation(req.params.conversationId, userId);
    if (access.error) return res.status(access.status).json({ error: access.error });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 80, 1), 100);
    const rows = await prisma.message.findMany({
      where: {
        conversationId: access.conversation.id,
        isDeleted: false,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: 'desc' }, take: limit,
      include: {
        sender: { select: { id: true, username: true, displayName: true, avatar: true, avatarColor: true } },
        replyTo: { select: { id: true, content: true, isDeleted: true, sender: { select: { displayName: true } } } },
        reactions: true, attachments: true,
      },
    });
    const ids = rows.map((m) => m.id);
    const [hidden, stars] = await Promise.all([
      prisma.messageHide.findMany({ where: { userId, messageId: { in: ids } }, select: { messageId: true } }),
      prisma.starredMessage.findMany({ where: { userId, messageId: { in: ids } }, select: { messageId: true } }),
    ]);
    const hiddenIds = new Set(hidden.map((x) => x.messageId));
    const starredIds = new Set(stars.map((x) => x.messageId));
    const messages = rows.filter((m) => !hiddenIds.has(m.id)).reverse().map((m) => ({
      ...m, isStarredByMe: starredIds.has(m.id),
      attachments: (m.attachments || []).map((a) => ({ ...a, fileSize: typeof a.fileSize === 'bigint' ? Number(a.fileSize) : a.fileSize })),
    }));
    return res.json({ success: true, data: { messages, total: messages.length, limit } });
  } catch (error) {
    console.error('[one-to-one] load messages:', error?.message || error);
    return res.status(500).json({ error: 'Could not load messages' });
  }
});

router.post('/conversations/:conversationId/messages', async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const access = await getConversation(req.params.conversationId, userId);
    if (access.error) return res.status(access.status).json({ error: access.error });
    const conversation = access.conversation;
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    const replyToId = req.body?.replyToId ? String(req.body.replyToId) : null;
    const requestedKind = String(req.body?.kind || 'text').toLowerCase();
    const attachmentIds = Array.isArray(req.body?.attachmentIds)
      ? [...new Set(req.body.attachmentIds.map((id) => String(id).trim()).filter(Boolean))]
      : [];
    if ((!content && !attachmentIds.length) || content.length > 5000) {
      return res.status(400).json({ error: 'Enter a message or attach a file', code: 'EMPTY_CONTENT' });
    }
    if (!attachmentIds.length && !['text', 'sticker'].includes(requestedKind)) {
      return res.status(400).json({ error: 'Unsupported message type', code: 'INVALID_MESSAGE_KIND' });
    }
    const peerId = conversation.user1Id === userId ? conversation.user2Id : conversation.user1Id;
    const blocked = await prisma.blockedUser.findFirst({
      where: { OR: [{ blockerId: userId, blockedId: peerId }, { blockerId: peerId, blockedId: userId }] },
    });
    if (blocked) return res.status(403).json({ error: 'You cannot message this user', code: 'USER_BLOCKED' });
    if (replyToId) {
      const parent = await prisma.message.findFirst({
        where: { id: replyToId, conversationId: conversation.id, isDeleted: false },
      });
      if (!parent) return res.status(404).json({ error: 'Reply message not found in this conversation', code: 'REPLY_NOT_FOUND' });
    }

    const now = new Date();
    const expiresAt = conversation.disappearingSeconds
      ? new Date(now.getTime() + conversation.disappearingSeconds * 1000)
      : null;
    const message = await prisma.$transaction(async (tx) => {
      let attachments = [];
      if (attachmentIds.length) {
        attachments = await tx.attachment.findMany({
          where: { id: { in: attachmentIds }, uploadedBy: userId, messageId: null },
        });
        if (attachments.length !== attachmentIds.length) {
          const error = new Error('ATTACHMENT_UNAVAILABLE');
          error.code = 'ATTACHMENT_UNAVAILABLE';
          throw error;
        }
        if (attachments.some((item) => !dmMimeTypes.has(String(item.mimeType || '').toLowerCase().split(';')[0]))) {
          const error = new Error('ATTACHMENT_TYPE_UNSUPPORTED');
          error.code = 'ATTACHMENT_TYPE_UNSUPPORTED';
          throw error;
        }
      }
      const kindForMime = (mime) => {
        if (mime.startsWith('audio/')) return 'audio';
        if (mime === 'image/gif') return 'gif';
        if (mime.startsWith('image/')) return 'photo';
        return 'file';
      };
      const kind = attachments.length
        ? (attachments.length === 1 ? kindForMime(String(attachments[0].mimeType || '').toLowerCase()) : 'file')
        : (requestedKind === 'sticker' ? 'sticker' : 'text');
      const fallback = attachments.length && attachments.every((item) => String(item.mimeType || '').startsWith('image/'))
        ? 'Photo'
        : attachments.length === 1 ? attachments[0].fileName : attachments.length ? 'Attachment' : content;
      const created = await tx.message.create({
        data: {
          content: content || fallback,
          kind,
          senderId: userId,
          conversationId: conversation.id,
          replyToId,
          expiresAt,
          createdAt: now,
        },
        include: {
          sender: { select: { id: true, username: true, displayName: true, avatar: true, avatarColor: true } },
          replyTo: { select: { id: true, content: true, isDeleted: true, sender: { select: { displayName: true } } } },
          reactions: true,
          attachments: true,
        },
      });
      if (attachmentIds.length) {
        const attached = await tx.attachment.updateMany({
          where: { id: { in: attachmentIds }, uploadedBy: userId, messageId: null },
          data: { messageId: created.id },
        });
        if (attached.count !== attachmentIds.length) {
          const error = new Error('ATTACHMENT_UNAVAILABLE');
          error.code = 'ATTACHMENT_UNAVAILABLE';
          throw error;
        }
      }
      const full = attachmentIds.length
        ? await tx.message.findUnique({
            where: { id: created.id },
            include: {
              sender: { select: { id: true, username: true, displayName: true, avatar: true, avatarColor: true } },
              replyTo: { select: { id: true, content: true, isDeleted: true, sender: { select: { displayName: true } } } },
              reactions: true,
              attachments: true,
            },
          })
        : created;
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { lastMessage: (content || fallback).slice(0, 100), lastMessageAt: now, lastMessageBy: userId },
      });
      return full;
    });

    const safeMessage = serializeMessage({ ...message, isStarredByMe: false });
    const io = req.app.get('io');
    emitToConversation(io, conversation.id, [conversation.user1Id, conversation.user2Id], 'message:new', {
      message: safeMessage,
      conversationId: conversation.id,
    });
    notifyNewMessage(prisma, io, {
      recipientId: peerId,
      senderId: userId,
      senderName: safeMessage.sender?.displayName || safeMessage.sender?.username || 'Someone',
      content: safeMessage.content,
      conversationId: conversation.id,
    }).catch(() => {});
    return res.status(201).json({ success: true, data: { message: safeMessage } });
  } catch (error) {
    if (error?.code === 'ATTACHMENT_UNAVAILABLE') {
      return res.status(400).json({ error: 'One or more attachments are unavailable', code: error.code });
    }
    if (error?.code === 'ATTACHMENT_TYPE_UNSUPPORTED') {
      return res.status(400).json({ error: 'One or more attachments use an unsupported file type', code: error.code });
    }
    console.error('[one-to-one] send message:', error?.message || error);
    return res.status(500).json({ error: 'Could not send message', code: 'SEND_ERROR' });
  }
});

router.post('/messages/:messageId/translate', translationRateLimit, async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const found = await getDirectMessage(req.params.messageId, userId);
    if (found.error) return res.status(found.status).json({ error: found.error });
    if (found.message.isDeleted) return res.status(404).json({ error: 'Message not found', code: 'NOT_FOUND' });
    const targetLanguage = typeof req.body?.targetLanguage === 'string' ? req.body.targetLanguage.trim() : '';
    if (!targetLanguage || targetLanguage.length > 60) {
      return res.status(400).json({ error: 'Choose a target language', code: 'INVALID_TARGET_LANGUAGE' });
    }
    if (!String(found.message.content || '').trim()) {
      return res.status(400).json({ error: 'This message has no text to translate', code: 'NO_TEXT' });
    }
    const translation = await translateText(found.message.content, targetLanguage);
    return res.json({ success: true, data: { messageId: found.message.id, targetLanguage, translation } });
  } catch (error) {
    if (error?.message === 'NO_KEY') {
      return res.status(503).json({ error: 'Translation is not available right now', code: 'AI_NOT_CONFIGURED' });
    }
    if (error?.message === 'INVALID_TRANSLATION_INPUT') {
      return res.status(400).json({ error: 'The message is too long to translate', code: 'INVALID_TRANSLATION_INPUT' });
    }
    console.error('[one-to-one] translate message:', error?.message || error);
    return res.status(502).json({ error: 'Translation is temporarily unavailable', code: 'AI_UPSTREAM' });
  }
});

router.post('/messages/:messageId/star', async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const found = await getDirectMessage(req.params.messageId, userId);
    if (found.error) return res.status(found.status).json({ error: found.error });
    if (found.message.isDeleted) return res.status(404).json({ error: 'Message not found' });
    const star = await prisma.starredMessage.upsert({
      where: { messageId_userId: { messageId: found.message.id, userId } },
      create: { messageId: found.message.id, userId },
      update: {},
    });
    return res.status(200).json({ success: true, data: { starred: true, star } });
  } catch (error) {
    console.error('[one-to-one] star message:', error?.message || error);
    return res.status(500).json({ error: 'Could not star message' });
  }
});

router.delete('/messages/:messageId/star', async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const found = await getDirectMessage(req.params.messageId, userId);
    if (found.error) return res.status(found.status).json({ error: found.error });
    await prisma.starredMessage.deleteMany({ where: { messageId: found.message.id, userId } });
    return res.status(200).json({ success: true, data: { starred: false } });
  } catch (error) {
    console.error('[one-to-one] unstar message:', error?.message || error);
    return res.status(500).json({ error: 'Could not unstar message' });
  }
});

router.get('/conversations/:conversationId/starred', async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const access = await getConversation(req.params.conversationId, userId);
    if (access.error) return res.status(access.status).json({ error: access.error });
    const rows = await prisma.starredMessage.findMany({
      where: { userId, message: { conversationId: access.conversation.id, isDeleted: false } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        message: {
          include: {
            sender: { select: { id: true, username: true, displayName: true, avatar: true } },
            attachments: true,
          },
        },
      },
    });
    const items = rows.map((row) => ({
      ...row,
      message: {
        ...row.message,
        isStarredByMe: true,
        attachments: (row.message.attachments || []).map((a) => ({
          ...a,
          fileSize: typeof a.fileSize === 'bigint' ? Number(a.fileSize) : a.fileSize,
        })),
      },
    }));
    return res.json({ success: true, data: { starredMessages: items } });
  } catch (error) {
    console.error('[one-to-one] list starred messages:', error?.message || error);
    return res.status(500).json({ error: 'Could not load starred messages' });
  }
});

router.post('/messages/:messageId/undo', async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const found = await getDirectMessage(req.params.messageId, userId);
    if (found.error) return res.status(found.status).json({ error: found.error });
    const message = found.message;
    if (message.senderId !== userId) return res.status(403).json({ error: 'You can only undo your own message', code: 'NOT_AUTHORIZED' });
    if (message.isDeleted) return res.status(404).json({ error: 'Message is already removed', code: 'NOT_FOUND' });
    if (Date.now() - new Date(message.createdAt).getTime() > 15000) {
      return res.status(409).json({ error: 'The undo window has expired', code: 'UNDO_EXPIRED' });
    }
    const now = new Date();
    await prisma.$transaction([
      prisma.message.update({ where: { id: message.id }, data: { isDeleted: true, deletedAt: now, content: '' } }),
      prisma.attachment.deleteMany({ where: { messageId: message.id } }),
      prisma.starredMessage.deleteMany({ where: { messageId: message.id } }),
      prisma.reaction.deleteMany({ where: { messageId: message.id } }),
    ]);
    const conversation = await prisma.conversation.findUnique({ where: { id: message.conversationId } });
    if (conversation) {
      emitToConversation(req.app.get('io'), conversation.id, [conversation.user1Id, conversation.user2Id], 'message:deleted', {
        messageId: message.id, scope: 'everyone', undone: true,
      });
    }
    return res.json({ success: true, data: { messageId: message.id, undone: true } });
  } catch (error) {
    console.error('[one-to-one] undo message:', error?.message || error);
    return res.status(500).json({ error: 'Could not undo message', code: 'UNDO_ERROR' });
  }
});

router.get('/conversations/:conversationId/disappearing', async (req, res) => {
  try {
    const access = await getConversation(req.params.conversationId, req.user?.id || req.userId);
    if (access.error) return res.status(access.status).json({ error: access.error });
    return res.json({ success: true, data: { seconds: access.conversation.disappearingSeconds || 0 } });
  } catch (error) {
    console.error('[one-to-one] get expiry setting:', error?.message || error);
    return res.status(500).json({ error: 'Could not load message expiry setting' });
  }
});

router.patch('/conversations/:conversationId/disappearing', async (req, res) => {
  try {
    const access = await getConversation(req.params.conversationId, req.user?.id || req.userId);
    if (access.error) return res.status(access.status).json({ error: access.error });
    const seconds = Number(req.body?.seconds);
    if (!DISAPPEARING_DURATIONS.has(seconds)) {
      return res.status(400).json({ error: 'Choose off, 1 day, 7 days, or 30 days' });
    }
    const conversation = await prisma.conversation.update({
      where: { id: access.conversation.id },
      data: { disappearingSeconds: seconds || null },
      select: { id: true, user1Id: true, user2Id: true, disappearingSeconds: true },
    });
    const io = req.app.get('io');
    emitToConversation(io, conversation.id, [conversation.user1Id, conversation.user2Id], 'conversation:disappearing-updated', {
      conversationId: conversation.id, seconds,
    });
    return res.json({ success: true, data: { seconds } });
  } catch (error) {
    console.error('[one-to-one] update expiry setting:', error?.message || error);
    return res.status(500).json({ error: 'Could not update message expiry setting' });
  }
});

router.post('/conversations/:conversationId/scheduled', async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const access = await getConversation(req.params.conversationId, userId);
    if (access.error) return res.status(access.status).json({ error: access.error });
    const content = String(req.body?.content || '').trim();
    const sendAt = new Date(req.body?.sendAt);
    const minAt = Date.now() + 30000;
    const maxAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    if (!content || content.length > 5000) return res.status(400).json({ error: 'Enter a message up to 5,000 characters' });
    if (!Number.isFinite(sendAt.getTime()) || sendAt.getTime() < minAt || sendAt.getTime() > maxAt) {
      return res.status(400).json({ error: 'Choose a send time between 30 seconds and 30 days from now' });
    }
    const otherId = access.conversation.user1Id === userId ? access.conversation.user2Id : access.conversation.user1Id;
    const blocked = await prisma.blockedUser.findFirst({
      where: { OR: [{ blockerId: userId, blockedId: otherId }, { blockerId: otherId, blockedId: userId }] },
    });
    if (blocked) return res.status(403).json({ error: 'You cannot message this user', code: 'USER_BLOCKED' });
    const scheduled = await prisma.scheduledMessage.create({
      data: { conversationId: access.conversation.id, senderId: userId, content, sendAt },
      select: { id: true, content: true, sendAt: true, status: true, createdAt: true },
    });
    return res.status(201).json({ success: true, data: { scheduledMessage: scheduled } });
  } catch (error) {
    console.error('[one-to-one] schedule message:', error?.message || error);
    return res.status(500).json({ error: 'Could not schedule message' });
  }
});

router.get('/conversations/:conversationId/scheduled', async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const access = await getConversation(req.params.conversationId, userId);
    if (access.error) return res.status(access.status).json({ error: access.error });
    const scheduledMessages = await prisma.scheduledMessage.findMany({
      where: { conversationId: access.conversation.id, senderId: userId, status: 'pending' },
      orderBy: { sendAt: 'asc' }, take: 50,
      select: { id: true, content: true, sendAt: true, status: true, createdAt: true },
    });
    return res.json({ success: true, data: { scheduledMessages } });
  } catch (error) {
    console.error('[one-to-one] list scheduled messages:', error?.message || error);
    return res.status(500).json({ error: 'Could not load scheduled messages' });
  }
});

router.delete('/scheduled/:scheduledId', async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const result = await prisma.scheduledMessage.updateMany({
      where: { id: req.params.scheduledId, senderId: userId, status: 'pending' },
      data: { status: 'cancelled' },
    });
    if (!result.count) return res.status(404).json({ error: 'Scheduled message not found or already sent' });
    return res.json({ success: true, data: { cancelled: true } });
  } catch (error) {
    console.error('[one-to-one] cancel scheduled message:', error?.message || error);
    return res.status(500).json({ error: 'Could not cancel scheduled message' });
  }
});

router.post('/conversations/:conversationId/location-shares', async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const access = await getConversation(req.params.conversationId, userId);
    if (access.error) return res.status(access.status).json({ error: access.error });
    const peerId = access.conversation.user1Id === userId ? access.conversation.user2Id : access.conversation.user1Id;
    const blocked = await prisma.blockedUser.findFirst({ where: { OR: [{ blockerId: userId, blockedId: peerId }, { blockerId: peerId, blockedId: userId }] } });
    if (blocked) return res.status(403).json({ error: 'Live location is unavailable in this conversation', code: 'USER_BLOCKED' });
    const latitude = Number(req.body?.latitude);
    const longitude = Number(req.body?.longitude);
    const durationSeconds = Number(req.body?.durationSeconds);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: 'A valid location is required' });
    }
    if (!LOCATION_DURATIONS.has(durationSeconds)) return res.status(400).json({ error: 'Choose 15 minutes, 1 hour, or 8 hours' });
    const share = await prisma.liveLocationShare.create({
      data: {
        conversationId: access.conversation.id, senderId: userId, latitude, longitude,
        expiresAt: new Date(Date.now() + durationSeconds * 1000),
      },
      include: { sender: { select: { id: true, displayName: true, username: true } } },
    });
    const io = req.app.get('io');
    emitToConversation(io, access.conversation.id, [access.conversation.user1Id, access.conversation.user2Id], 'location-share:started', { share });
    return res.status(201).json({ success: true, data: { share } });
  } catch (error) {
    console.error('[one-to-one] start location share:', error?.message || error);
    return res.status(500).json({ error: 'Could not start location sharing' });
  }
});

router.get('/conversations/:conversationId/location-shares', async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const access = await getConversation(req.params.conversationId, userId);
    if (access.error) return res.status(access.status).json({ error: access.error });
    const peerId = access.conversation.user1Id === userId ? access.conversation.user2Id : access.conversation.user1Id;
    const blocked = await prisma.blockedUser.findFirst({ where: { OR: [{ blockerId: userId, blockedId: peerId }, { blockerId: peerId, blockedId: userId }] } });
    if (blocked) return res.json({ success: true, data: { shares: [] } });
    const shares = await prisma.liveLocationShare.findMany({
      where: { conversationId: access.conversation.id, stoppedAt: null, expiresAt: { gt: new Date() } },
      include: { sender: { select: { id: true, displayName: true, username: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ success: true, data: { shares } });
  } catch (error) {
    console.error('[one-to-one] load location shares:', error?.message || error);
    return res.status(500).json({ error: 'Could not load live locations' });
  }
});

router.patch('/location-shares/:shareId', async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const share = await prisma.liveLocationShare.findFirst({
      where: { id: req.params.shareId, senderId: userId, stoppedAt: null, expiresAt: { gt: new Date() } },
      include: { conversation: { select: { user1Id: true, user2Id: true } } },
    });
    if (!share) return res.status(404).json({ error: 'Live location is no longer active' });
    const peerId = share.conversation.user1Id === userId ? share.conversation.user2Id : share.conversation.user1Id;
    const blocked = await prisma.blockedUser.findFirst({ where: { OR: [{ blockerId: userId, blockedId: peerId }, { blockerId: peerId, blockedId: userId }] } });
    if (blocked) {
      const stoppedAt = new Date();
      await prisma.liveLocationShare.updateMany({ where: { id: share.id, stoppedAt: null }, data: { stoppedAt } });
      emitToConversation(req.app.get('io'), share.conversationId, [share.conversation.user1Id, share.conversation.user2Id], 'location-share:stopped', { shareId: share.id, conversationId: share.conversationId });
      return res.status(403).json({ error: 'Live location is unavailable in this conversation', code: 'USER_BLOCKED' });
    }
    const latitude = Number(req.body?.latitude);
    const longitude = Number(req.body?.longitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return res.status(400).json({ error: 'A valid location is required' });
    }
    const updated = await prisma.liveLocationShare.update({
      where: { id: share.id }, data: { latitude, longitude },
      include: { sender: { select: { id: true, displayName: true, username: true } } },
    });
    emitToConversation(req.app.get('io'), share.conversationId, [share.conversation.user1Id, share.conversation.user2Id], 'location-share:updated', { share: updated });
    return res.json({ success: true, data: { share: updated } });
  } catch (error) {
    console.error('[one-to-one] update location:', error?.message || error);
    return res.status(500).json({ error: 'Could not update live location' });
  }
});

router.delete('/location-shares/:shareId', async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const share = await prisma.liveLocationShare.findFirst({
      where: { id: req.params.shareId, senderId: userId, stoppedAt: null },
      include: { conversation: { select: { user1Id: true, user2Id: true } } },
    });
    if (!share) return res.status(404).json({ error: 'Live location is no longer active' });
    await prisma.liveLocationShare.update({ where: { id: share.id }, data: { stoppedAt: new Date() } });
    emitToConversation(req.app.get('io'), share.conversationId, [share.conversation.user1Id, share.conversation.user2Id], 'location-share:stopped', { shareId: share.id, conversationId: share.conversationId });
    return res.json({ success: true, data: { stopped: true } });
  } catch (error) {
    console.error('[one-to-one] stop location:', error?.message || error);
    return res.status(500).json({ error: 'Could not stop live location' });
  }
});

router.get('/calls/ice-servers', (req, res) => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  const turnUrls = String(process.env.TURN_URL || '').split(',').map((value) => value.trim()).filter(Boolean);
  const secret = process.env.TURN_SHARED_SECRET;
  const userId = req.userId || req.user?.id;
  if (turnUrls.length && secret && userId) {
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const username = `${expiry}:${userId}`;
    const credential = createHmac('sha1', secret).update(username).digest('base64');
    iceServers.push({ urls: turnUrls, username, credential });
  }
  return res.json({ success: true, data: { iceServers, turnConfigured: iceServers.length > 1 } });
});

export async function processOneToOneMaintenance(prismaClient = prisma, io = null) {
  const now = new Date();
  const due = await prismaClient.scheduledMessage.findMany({
    where: { status: 'pending', sendAt: { lte: now } },
    orderBy: { sendAt: 'asc' },
    take: 25,
    select: { id: true },
  });
  for (const item of due) {
    try {
      const result = await prismaClient.$transaction(async (tx) => {
        const claimed = await tx.scheduledMessage.updateMany({
          where: { id: item.id, status: 'pending', sendAt: { lte: now } },
          data: { status: 'sending' },
        });
        if (!claimed.count) return null;
        const job = await tx.scheduledMessage.findUnique({ where: { id: item.id } });
        const conversation = job && await tx.conversation.findUnique({ where: { id: job.conversationId } });
        if (!job || !conversation || (conversation.user1Id !== job.senderId && conversation.user2Id !== job.senderId)) {
          if (job) await tx.scheduledMessage.update({ where: { id: job.id }, data: { status: 'failed' } });
          return null;
        }
        const otherId = conversation.user1Id === job.senderId ? conversation.user2Id : conversation.user1Id;
        const blocked = await tx.blockedUser.findFirst({
          where: { OR: [{ blockerId: job.senderId, blockedId: otherId }, { blockerId: otherId, blockedId: job.senderId }] },
        });
        if (blocked) {
          await tx.scheduledMessage.update({ where: { id: job.id }, data: { status: 'failed' } });
          return null;
        }
        const sentAt = new Date();
        const expiresAt = conversation.disappearingSeconds
          ? new Date(sentAt.getTime() + conversation.disappearingSeconds * 1000)
          : null;
        const message = await tx.message.create({
          data: {
            content: job.content,
            kind: 'text',
            senderId: job.senderId,
            conversationId: job.conversationId,
            createdAt: sentAt,
            expiresAt,
          },
          include: {
            sender: { select: { id: true, username: true, displayName: true, avatar: true, avatarColor: true } },
          },
        });
        await tx.conversation.update({
          where: { id: job.conversationId },
          data: { lastMessage: job.content.slice(0, 100), lastMessageAt: sentAt, lastMessageBy: job.senderId },
        });
        await tx.scheduledMessage.update({
          where: { id: job.id },
          data: { status: 'sent', sentAt },
        });
        return {
          message,
          conversationId: job.conversationId,
          senderId: job.senderId,
          otherId,
          user1Id: conversation.user1Id,
          user2Id: conversation.user2Id,
        };
      });
      if (result) {
        const message = serializeMessage(result.message);
        emitToConversation(io, result.conversationId, [result.user1Id, result.user2Id], 'message:new', {
          message,
          conversationId: result.conversationId,
        });
        notifyNewMessage(prismaClient, io, {
          recipientId: result.otherId,
          senderId: result.senderId,
          senderName: message.sender?.displayName || message.sender?.username || 'Someone',
          content: message.content,
          conversationId: result.conversationId,
        }).catch(() => {});
      }
    } catch (error) {
      console.error('[one-to-one] scheduled send failed:', item.id, error?.message || error);
    }
  }

  const expired = await prismaClient.message.findMany({
    where: { conversationId: { not: null }, isDeleted: false, expiresAt: { lte: now } },
    take: 100,
    select: { id: true, conversationId: true, conversation: { select: { user1Id: true, user2Id: true } } },
  });
  for (const item of expired) {
    try {
      const removed = await prismaClient.message.deleteMany({
        where: { id: item.id, isDeleted: false, expiresAt: { lte: now } },
      });
      if (removed.count) {
        emitToConversation(io, item.conversationId, [item.conversation.user1Id, item.conversation.user2Id], 'message:deleted', {
          messageId: item.id,
          scope: 'everyone',
          expired: true,
        });
      }
    } catch (error) {
      console.error('[one-to-one] expire message failed:', item.id, error?.message || error);
    }
  }

  const expiredShares = await prismaClient.liveLocationShare.findMany({
    where: { stoppedAt: null, expiresAt: { lte: now } },
    take: 100,
    select: { id: true, conversationId: true, conversation: { select: { user1Id: true, user2Id: true } } },
  });
  for (const share of expiredShares) {
    try {
      const stopped = await prismaClient.liveLocationShare.updateMany({
        where: { id: share.id, stoppedAt: null, expiresAt: { lte: now } },
        data: { stoppedAt: now },
      });
      if (stopped.count) {
        emitToConversation(io, share.conversationId, [share.conversation.user1Id, share.conversation.user2Id], 'location-share:stopped', {
          shareId: share.id,
          conversationId: share.conversationId,
          expired: true,
        });
      }
    } catch (error) {
      console.error('[one-to-one] expire location share failed:', share.id, error?.message || error);
    }
  }
}

export function startOneToOneMaintenance(io) {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await processOneToOneMaintenance(prisma, io);
    } catch (error) {
      console.error('[one-to-one] maintenance failed:', error?.message || error);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(run, 5000);
  timer.unref?.();
  void run();
  return timer;
}

export { initOneToOneCallHandler } from './callSignals.js';

export default router;
