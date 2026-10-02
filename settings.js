import express from 'express';
import { prisma } from './server.js';
import { authenticateToken } from './jwt.js';

const router = express.Router();

router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    let settings = await prisma.userSettings.findUnique({ where: { userId } });
    if (!settings) {
      settings = await prisma.userSettings.create({ data: { userId } });
    }
    res.status(200).json({ success: true, data: { settings } });
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ error: 'Failed to fetch settings', code: 'FETCH_ERROR' });
  }
});

router.patch('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const body = req.body || {};
    let settings = await prisma.userSettings.findUnique({ where: { userId } });
    if (!settings) {
      settings = await prisma.userSettings.create({ data: { userId } });
    }

    const updateData = {};
    const boolKeys = [
      'notificationsEnabled',
      'soundEnabled',
      'twoFactorEnabled',
      'showOnlineStatus',
      'showReadReceipts',
      'allowUnknownMessages',
    ];
    for (const k of boolKeys) {
      if (body[k] !== undefined) updateData[k] = !!body[k];
    }
    if (body.theme !== undefined) {
      if (!['light', 'dark', 'auto'].includes(body.theme)) {
        return res.status(400).json({ error: 'Invalid theme' });
      }
      updateData.theme = body.theme;
    }
    if (body.language !== undefined) {
      updateData.language = String(body.language).slice(0, 10);
    }

    settings = await prisma.userSettings.update({
      where: { userId },
      data: updateData,
    });
    res.status(200).json({ success: true, data: { settings } });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({ error: 'Failed to update settings', code: 'UPDATE_ERROR' });
  }
});

export default router;
