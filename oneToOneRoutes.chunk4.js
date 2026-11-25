import express from 'express';
import { createHmac } from 'node:crypto';
import multer from 'multer';
import { rateLimit } from './scale.js';
import { prisma } from './prisma.js';
import { authenticateToken } from './auth.js';
import { notifyNewMessage } from './notifications.js';
import { translateText } from './ai.js';

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

export function registerChunk4(router) {
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
      return res.status(403).json({ error: 'You cannot share location in this conversation' });
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
}
