import express from 'express';
import { prisma } from './server.js';
import { authenticateToken } from './jwt.js';

const router = express.Router();

// ============================================================================
// GET USER SETTINGS ENDPOINT
// ============================================================================

router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;

    let settings = await prisma.userSettings.findUnique({
      where: { userId }
    });

    if (!settings) {
      settings = await prisma.userSettings.create({
        data: { userId }
      });
    }

    res.status(200).json({
      success: true,
      data: { settings }
    });
  } catch (error) {
    console.error('Get settings error:', error);

    res.status(500).json({
      error: 'Failed to fetch settings',
      code: 'FETCH_ERROR'
    });
  }
});

// ============================================================================
// UPDATE USER SETTINGS ENDPOINT
// ============================================================================

router.patch('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const {
      notificationsEnabled,
      soundEnabled,
      theme,
      language,
      twoFactorEnabled,
      showOnlineStatus,
      showReadReceipts,
      allowUnknownMessages
    } = req.body;

    let settings = await prisma.userSettings.findUnique({
      where: { userId }
    });

    if (!settings) {
      settings = await prisma.userSettings.create({
        data: { userId }
      });
    }

    const updateData = {};

    if (notificationsEnabled !== undefined) {
      updateData.notificationsEnabled = notificationsEnabled;
    }

    if (soundEnabled !== undefined) {
      updateData.soundEnabled = soundEnabled;
    }

    if (theme !== undefined) {
      if (!['light', 'dark', 'auto'].includes(theme)) {
        return res.status(400).json({
          error: 'Invalid theme',
          code: 'INVALID_THEME'
        });
      }
      updateData.theme = theme;
    }

    if (language !== undefined) {
      if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(language)) {
        return res.status(400).json({
          error: 'Invalid language code',
          code: 'INVALID_LANGUAGE'
        });
      }
      updateData.language = language;
    }

    if (twoFactorEnabled !== undefined) {
      updateData.twoFactorEnabled = twoFactorEnabled;
    }

    if (showOnlineStatus !== undefined) {
      updateData.showOnlineStatus = showOnlineStatus;
    }

    if (showReadReceipts !== undefined) {
      updateData.showReadReceipts = showReadReceipts;
    }

    if (allowUnknownMessages !== undefined) {
      updateData.allowUnknownMessages = allowUnknownMessages;
    }

    const updatedSettings = await prisma.userSettings.update({
      where: { userId },
      data: updateData
    });

    res.status(200).json({
      success: true,
      data: { settings: updatedSettings }
    });
  } catch (error) {
    console.error('Update settings error:', error);

    res.status(500).json({
      error: 'Failed to update settings',
      code: 'UPDATE_ERROR'
    });
  }
});

// ============================================================================
// GET NOTIFICATIONS ENDPOINT
// ============================================================================

router.get('/notifications', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { limit = 50, offset = 0 } = req.query;

    const notifications = await prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit) || 50, 100),
      skip: Math.max(parseInt(offset) || 0, 0)
    });

    const total = await prisma.notification.count({
      where: { userId }
    });

    const unreadCount = await prisma.notification.count({
      where: {
        userId,
        read: false
      }
    });

    res.status(200).json({
      success: true,
      data: {
        notifications,
        total,
        unreadCount,
        limit: Math.min(parseInt(limit) || 50, 100),
        offset: Math.max(parseInt(offset) || 0, 0)
      }
    });
  } catch (error) {
    console.error('Get notifications error:', error);

    res.status(500).json({
      error: 'Failed to fetch notifications',
      code: 'FETCH_ERROR'
    });
  }
});

// ============================================================================
// MARK NOTIFICATION AS READ ENDPOINT
// ============================================================================

router.patch('/notifications/:notificationId', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { notificationId } = req.params;

    const notification = await prisma.notification.findUnique({
      where: { id: notificationId }
    });

    if (!notification) {
      return res.status(404).json({
        error: 'Notification not found',
        code: 'NOT_FOUND'
      });
    }

    if (notification.userId !== userId) {
      return res.status(403).json({
        error: 'You cannot mark other users notifications as read',
        code: 'NOT_AUTHORIZED'
      });
    }

    const updatedNotification = await prisma.notification.update({
      where: { id: notificationId },
      data: { read: true }
    });

    res.status(200).json({
      success: true,
      data: { notification: updatedNotification }
    });
  } catch (error) {
    console.error('Mark notification as read error:', error);

    res.status(500).json({
      error: 'Failed to update notification',
      code: 'UPDATE_ERROR'
    });
  }
});

// ============================================================================
// MARK ALL NOTIFICATIONS AS READ ENDPOINT
// ============================================================================

router.post('/notifications/read-all', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;

    await prisma.notification.updateMany({
      where: {
        userId,
        read: false
      },
      data: { read: true }
    });

    res.status(200).json({
      success: true,
      message: 'All notifications marked as read'
    });
  } catch (error) {
    console.error('Mark all notifications as read error:', error);

    res.status(500).json({
      error: 'Failed to update notifications',
      code: 'UPDATE_ERROR'
    });
  }
});

// ============================================================================
// DELETE NOTIFICATION ENDPOINT
// ============================================================================

router.delete('/notifications/:notificationId', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { notificationId } = req.params;

    const notification = await prisma.notification.findUnique({
      where: { id: notificationId }
    });

    if (!notification) {
      return res.status(404).json({
        error: 'Notification not found',
        code: 'NOT_FOUND'
      });
    }

    if (notification.userId !== userId) {
      return res.status(403).json({
        error: 'You cannot delete other users notifications',
        code: 'NOT_AUTHORIZED'
      });
    }

    await prisma.notification.delete({
      where: { id: notificationId }
    });

    res.status(200).json({
      success: true,
      message: 'Notification deleted'
    });
  } catch (error) {
    console.error('Delete notification error:', error);

    res.status(500).json({
      error: 'Failed to delete notification',
      code: 'DELETE_ERROR'
    });
  }
});

// ============================================================================
// DELETE ALL NOTIFICATIONS ENDPOINT
// ============================================================================

router.delete('/notifications', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;

    await prisma.notification.deleteMany({
      where: { userId }
    });

    res.status(200).json({
      success: true,
      message: 'All notifications deleted'
    });
  } catch (error) {
    console.error('Delete all notifications error:', error);

    res.status(500).json({
      error: 'Failed to delete notifications',
      code: 'DELETE_ERROR'
    });
  }
});

// ============================================================================
// ADD TO BLOCK LIST ENDPOINT
// ============================================================================

router.post('/blocklist', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { blockedUserId } = req.body;

    if (!blockedUserId) {
      return res.status(400).json({
        error: 'Blocked user ID is required',
        code: 'MISSING_USER_ID'
      });
    }

    let settings = await prisma.userSettings.findUnique({
      where: { userId }
    });

    if (!settings) {
      settings = await prisma.userSettings.create({
        data: { userId }
      });
    }

    if (settings.blockList.includes(blockedUserId)) {
      return res.status(409).json({
        error: 'User is already blocked',
        code: 'ALREADY_BLOCKED'
      });
    }

    const updatedSettings = await prisma.userSettings.update({
      where: { userId },
      data: {
        blockList: [...settings.blockList, blockedUserId]
      }
    });

    res.status(200).json({
      success: true,
      data: { settings: updatedSettings }
    });
  } catch (error) {
    console.error('Add to blocklist error:', error);

    res.status(500).json({
      error: 'Failed to block user',
      code: 'BLOCK_ERROR'
    });
  }
});

// ============================================================================
// REMOVE FROM BLOCK LIST ENDPOINT
// ============================================================================

router.delete('/blocklist/:blockedUserId', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { blockedUserId } = req.params;

    const settings = await prisma.userSettings.findUnique({
      where: { userId }
    });

    if (!settings || !settings.blockList.includes(blockedUserId)) {
      return res.status(404).json({
        error: 'User is not blocked',
        code: 'NOT_BLOCKED'
      });
    }

    const updatedSettings = await prisma.userSettings.update({
      where: { userId },
      data: {
        blockList: settings.blockList.filter(id => id !== blockedUserId)
      }
    });

    res.status(200).json({
      success: true,
      data: { settings: updatedSettings }
    });
  } catch (error) {
    console.error('Remove from blocklist error:', error);

    res.status(500).json({
      error: 'Failed to unblock user',
      code: 'UNBLOCK_ERROR'
    });
  }
});

// ============================================================================
// MUTE USER ENDPOINT
// ============================================================================

router.post('/mutelist', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { mutedUserId } = req.body;

    if (!mutedUserId) {
      return res.status(400).json({
        error: 'Muted user ID is required',
        code: 'MISSING_USER_ID'
      });
    }

    let settings = await prisma.userSettings.findUnique({
      where: { userId }
    });

    if (!settings) {
      settings = await prisma.userSettings.create({
        data: { userId }
      });
    }

    if (settings.muteList.includes(mutedUserId)) {
      return res.status(409).json({
        error: 'User is already muted',
        code: 'ALREADY_MUTED'
      });
    }

    const updatedSettings = await prisma.userSettings.update({
      where: { userId },
      data: {
        muteList: [...settings.muteList, mutedUserId]
      }
    });

    res.status(200).json({
      success: true,
      data: { settings: updatedSettings }
    });
  } catch (error) {
    console.error('Mute user error:', error);

    res.status(500).json({
      error: 'Failed to mute user',
      code: 'MUTE_ERROR'
    });
  }
});

// ============================================================================
// UNMUTE USER ENDPOINT
// ============================================================================

router.delete('/mutelist/:mutedUserId', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { mutedUserId } = req.params;

    const settings = await prisma.userSettings.findUnique({
      where: { userId }
    });

    if (!settings || !settings.muteList.includes(mutedUserId)) {
      return res.status(404).json({
        error: 'User is not muted',
        code: 'NOT_MUTED'
      });
    }

    const updatedSettings = await prisma.userSettings.update({
      where: { userId },
      data: {
        muteList: settings.muteList.filter(id => id !== mutedUserId)
      }
    });

    res.status(200).json({
      success: true,
      data: { settings: updatedSettings }
    });
  } catch (error) {
    console.error('Unmute user error:', error);

    res.status(500).json({
      error: 'Failed to unmute user',
      code: 'UNMUTE_ERROR'
    });
  }
});

export default router;
