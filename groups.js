import express from 'express';
import { prisma } from './prisma.js';
import { authenticateToken } from './jwt.js';

const router = express.Router();

const requireGroupMembership = async (req, res, next) => {
  try {
    const userId = req.user?.id || req.userId;
    const { groupId } = req.params;
    if (!groupId) {
      return res.status(400).json({ error: 'Group ID is required', code: 'MISSING_GROUP_ID' });
    }
    const member = await prisma.groupMember.findFirst({ where: { groupId, userId } });
    if (!member) {
      return res.status(403).json({ error: 'You do not have access to this group', code: 'NO_ACCESS' });
    }
    next();
  } catch (error) {
    next(error);
  }
};

const requireGroupAdmin = async (req, res, next) => {
  try {
    const userId = req.user?.id || req.userId;
    const { groupId } = req.params;
    if (!groupId) {
      return res.status(400).json({ error: 'Group ID is required', code: 'MISSING_GROUP_ID' });
    }
    const member = await prisma.groupMember.findFirst({ where: { groupId, userId } });
    if (!member || !['admin', 'owner'].includes(member.role)) {
      return res.status(403).json({ error: 'You do not have admin permissions for this group', code: 'NOT_AUTHORIZED' });
    }
    next();
  } catch (error) {
    next(error);
  }
};

router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized', code: 'NO_USER' });
    }
    const { name, description, isPublic = false } = req.body || {};
    let rawMembers = req.body?.memberIds ?? req.body?.members ?? req.body?.userIds ?? [];
    if (!Array.isArray(rawMembers)) rawMembers = [];
    const memberIds = [
      ...new Set(
        rawMembers
          .map((m) => (typeof m === 'object' && m ? m.id || m.userId : m))
          .filter((id) => id != null && String(id) !== String(userId))
          .map((id) => String(id))
      ),
    ];

    if (!name || String(name).trim().length === 0) {
      return res.status(400).json({ error: 'Group name is required', code: 'MISSING_NAME' });
    }
    if (String(name).length > 100) {
      return res.status(400).json({ error: 'Group name must be less than 100 characters', code: 'NAME_TOO_LONG' });
    }
    if (description && String(description).length > 500) {
      return res.status(400).json({ error: 'Group description must be less than 500 characters', code: 'DESCRIPTION_TOO_LONG' });
    }
    if (memberIds.length === 0) {
      return res.status(400).json({
        error: 'Add at least one member to the group',
        code: 'NO_MEMBERS',
      });
    }

    const existing = await prisma.user.findMany({
      where: { id: { in: memberIds } },
      select: { id: true },
    });
    const validIds = existing.map((u) => u.id);
    if (validIds.length === 0) {
      return res.status(400).json({
        error: 'None of the selected members were found',
        code: 'MEMBERS_NOT_FOUND',
      });
    }

    const group = await prisma.group.create({
      data: {
        name: String(name).trim(),
        description: description ? String(description).trim() : null,
        createdById: userId,
        isPublic: !!isPublic,
        members: {
          create: [
            { userId, role: 'owner' },
            ...validIds.map((id) => ({ userId: id, role: 'member' })),
          ],
        },
      },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatar: true,
                avatarColor: true,
                isOnline: true,
              },
            },
          },
        },
        createdBy: {
          select: { id: true, username: true, displayName: true, avatar: true },
        },
        _count: { select: { messages: true, members: true } },
      },
    });
    res.status(201).json({ success: true, data: { group } });
  } catch (error) {
    console.error('Create group error:', error);
    res.status(500).json({
      error: error?.message || 'Failed to create group',
      code: 'CREATE_ERROR',
    });
  }
});
