import express from 'express';
import { prisma } from './prisma.js';

const router = express.Router();

/** List notifications for current user */
router.get('/', async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const take = Math.min(parseInt(req.query.limit || '50', 10) || 50, 100);
    const items = await prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take,
    });
    const unread = await prisma.notification.count({
      where: { userId, read: false },
    });
    res.status(200).json({ success: true, data: { notifications: items, unread } });
  } catch (error) {
    console.error('List notifications', error);
    res.status(500).json({ error: 'Failed to fetch notifications', code: 'FETCH_ERROR' });
  }
});

/** Mark one notification read */
router.post('/:id/read', async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const { id } = req.params;
    const n = await prisma.notification.findFirst({ where: { id, userId } });
    if (!n) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    const updated = await prisma.notification.update({
      where: { id },
      data: { read: true },
    });
    res.status(200).json({ success: true, data: { notification: updated } });
  } catch (error) {
    console.error('Read notification', error);
    res.status(500).json({ error: 'Failed to update notification', code: 'UPDATE_ERROR' });
  }
});

/** Mark all read */
router.post('/read-all', async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    await prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Read all notifications', error);
    res.status(500).json({ error: 'Failed to update notifications', code: 'UPDATE_ERROR' });
  }
});

export default router;
