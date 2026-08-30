import express from 'express';
import { prisma } from './server.js';
import { authenticateToken, requireGroupMembership, requireGroupAdmin } from './jwt.js';

const router = express.Router();

// ============================================================================
// CREATE GROUP ENDPOINT
// ============================================================================

router.post('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { name, description, isPublic = false, memberIds = [] } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({
        error: 'Group name is required',
        code: 'MISSING_NAME'
      });
    }

    if (name.length > 100) {
      return res.status(400).json({
        error: 'Group name must be less than 100 characters',
        code: 'NAME_TOO_LONG'
      });
    }

    if (description && description.length > 500) {
      return res.status(400).json({
        error: 'Group description must be less than 500 characters',
        code: 'DESCRIPTION_TOO_LONG'
      });
    }

    const group = await prisma.group.create({
      data: {
        name: name.trim(),
        description: description?.trim() || null,
        createdById: userId,
        isPublic,
        avatar: `https://api.dicebear.com/7.x/initials/svg?seed=${name}`,
        members: {
          create: [
            {
              userId,
              role: 'owner'
            },
            ...memberIds.filter(id => id !== userId).map(id => ({
              userId: id,
              role: 'member'
            }))
          ]
        }
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
                isOnline: true
              }
            }
          }
        },
        createdBy: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatar: true
          }
        },
        _count: {
          select: { messages: true }
        }
      }
    });

    res.status(201).json({
      success: true,
      data: { group }
    });
  } catch (error) {
    console.error('Create group error:', error);

    res.status(500).json({
      error: 'Failed to create group',
      code: 'CREATE_ERROR'
    });
  }
});

// ============================================================================
// GET ALL GROUPS ENDPOINT
// ============================================================================

router.get('/', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { limit = 50, offset = 0 } = req.query;

    const groups = await prisma.group.findMany({
      where: {
        members: {
          some: { userId }
        }
      },
      include: {
        createdBy: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatar: true
          }
        },
        members: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatar: true
              }
            }
          }
        },
        _count: {
          select: { messages: true }
        }
      },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(parseInt(limit) || 50, 100),
      skip: Math.max(parseInt(offset) || 0, 0)
    });

    const total = await prisma.group.count({
      where: {
        members: {
          some: { userId }
        }
      }
    });

    res.status(200).json({
      success: true,
      data: {
        groups,
        total,
        limit: Math.min(parseInt(limit) || 50, 100),
        offset: Math.max(parseInt(offset) || 0, 0)
      }
    });
  } catch (error) {
    console.error('Get groups error:', error);

    res.status(500).json({
      error: 'Failed to fetch groups',
      code: 'FETCH_ERROR'
    });
  }
});

// ============================================================================
// GET GROUP BY ID ENDPOINT
// ============================================================================

router.get('/:groupId', authenticateToken, requireGroupMembership, async (req, res) => {
  try {
    const { groupId } = req.params;

    const group = await prisma.group.findUnique({
      where: { id: groupId },
      include: {
        createdBy: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatar: true
          }
        },
        members: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatar: true,
                isOnline: true,
                isVerified: true
              }
            }
          }
        },
        _count: {
          select: { messages: true }
        }
      }
    });

    if (!group) {
      return res.status(404).json({
        error: 'Group not found',
        code: 'NOT_FOUND'
      });
    }

    res.status(200).json({
      success: true,
      data: { group }
    });
  } catch (error) {
    console.error('Get group error:', error);

    res.status(500).json({
      error: 'Failed to fetch group',
      code: 'FETCH_ERROR'
    });
  }
});

// ============================================================================
// UPDATE GROUP ENDPOINT
// ============================================================================

router.patch('/:groupId', authenticateToken, requireGroupAdmin, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { name, description, isPublic } = req.body;

    const updateData = {};

    if (name !== undefined) {
      if (name.length > 100) {
        return res.status(400).json({
          error: 'Group name must be less than 100 characters',
          code: 'NAME_TOO_LONG'
        });
      }
      updateData.name = name.trim();
    }

    if (description !== undefined) {
      if (description.length > 500) {
        return res.status(400).json({
          error: 'Group description must be less than 500 characters',
          code: 'DESCRIPTION_TOO_LONG'
        });
      }
      updateData.description = description.trim();
    }

    if (isPublic !== undefined) {
      updateData.isPublic = isPublic;
    }

    const updatedGroup = await prisma.group.update({
      where: { id: groupId },
      data: updateData,
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatar: true
              }
            }
          }
        },
        createdBy: {
          select: {
            id: true,
            username: true,
            displayName: true
          }
        },
        _count: { select: { messages: true } }
      }
    });

    res.status(200).json({
      success: true,
      data: { group: updatedGroup }
    });
  } catch (error) {
    console.error('Update group error:', error);

    res.status(500).json({
      error: 'Failed to update group',
      code: 'UPDATE_ERROR'
    });
  }
});

// ============================================================================
// DELETE GROUP ENDPOINT
// ============================================================================

router.delete('/:groupId', authenticateToken, requireGroupAdmin, async (req, res) => {
  try {
    const userId = req.userId;
    const { groupId } = req.params;

    const group = await prisma.group.findUnique({
      where: { id: groupId }
    });

    if (group.createdById !== userId) {
      return res.status(403).json({
        error: 'Only the group creator can delete the group',
        code: 'NOT_AUTHORIZED'
      });
    }

    await prisma.message.deleteMany({
      where: { groupId }
    });

    await prisma.groupMember.deleteMany({
      where: { groupId }
    });

    await prisma.group.delete({
      where: { id: groupId }
    });

    res.status(200).json({
      success: true,
      message: 'Group deleted'
    });
  } catch (error) {
    console.error('Delete group error:', error);

    res.status(500).json({
      error: 'Failed to delete group',
      code: 'DELETE_ERROR'
    });
  }
});

// ============================================================================
// ADD MEMBER TO GROUP ENDPOINT
// ============================================================================

router.post('/:groupId/members', authenticateToken, requireGroupAdmin, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { userId: newMemberId, role = 'member' } = req.body;

    if (!newMemberId) {
      return res.status(400).json({
        error: 'User ID is required',
        code: 'MISSING_USER_ID'
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: newMemberId },
      select: { id: true }
    });

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    const existingMember = await prisma.groupMember.findFirst({
      where: {
        groupId,
        userId: newMemberId
      }
    });

    if (existingMember) {
      return res.status(409).json({
        error: 'User is already a member of this group',
        code: 'ALREADY_MEMBER'
      });
    }

    const member = await prisma.groupMember.create({
      data: {
        groupId,
        userId: newMemberId,
        role: ['member', 'admin', 'owner'].includes(role) ? role : 'member'
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatar: true
          }
        }
      }
    });

    res.status(201).json({
      success: true,
      data: { member }
    });
  } catch (error) {
    console.error('Add member error:', error);

    res.status(500).json({
      error: 'Failed to add member',
      code: 'ADD_ERROR'
    });
  }
});

// ============================================================================
// UPDATE MEMBER ROLE ENDPOINT
// ============================================================================

router.patch('/:groupId/members/:memberId', authenticateToken, requireGroupAdmin, async (req, res) => {
  try {
    const { groupId, memberId } = req.params;
    const { role } = req.body;

    if (!['member', 'admin', 'owner'].includes(role)) {
      return res.status(400).json({
        error: 'Invalid role',
        code: 'INVALID_ROLE'
      });
    }

    const member = await prisma.groupMember.findFirst({
      where: {
        id: memberId,
        groupId
      }
    });

    if (!member) {
      return res.status(404).json({
        error: 'Member not found',
        code: 'NOT_FOUND'
      });
    }

    const updatedMember = await prisma.groupMember.update({
      where: { id: memberId },
      data: { role },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatar: true
          }
        }
      }
    });

    res.status(200).json({
      success: true,
      data: { member: updatedMember }
    });
  } catch (error) {
    console.error('Update member error:', error);

    res.status(500).json({
      error: 'Failed to update member',
      code: 'UPDATE_ERROR'
    });
  }
});

// ============================================================================
// REMOVE MEMBER FROM GROUP ENDPOINT
// ============================================================================

router.delete('/:groupId/members/:memberId', authenticateToken, requireGroupAdmin, async (req, res) => {
  try {
    const { groupId, memberId } = req.params;

    const member = await prisma.groupMember.findFirst({
      where: {
        id: memberId,
        groupId
      }
    });

    if (!member) {
      return res.status(404).json({
        error: 'Member not found',
        code: 'NOT_FOUND'
      });
    }

    await prisma.groupMember.delete({
      where: { id: memberId }
    });

    res.status(200).json({
      success: true,
      message: 'Member removed from group'
    });
  } catch (error) {
    console.error('Remove member error:', error);

    res.status(500).json({
      error: 'Failed to remove member',
      code: 'REMOVE_ERROR'
    });
  }
});

// ============================================================================
// GET GROUP MESSAGES ENDPOINT
// ============================================================================

router.get('/:groupId/messages', authenticateToken, requireGroupMembership, async (req, res) => {
  try {
    const { groupId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const messages = await prisma.message.findMany({
      where: { groupId },
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatar: true
          }
        },
        replyTo: {
          select: {
            id: true,
            content: true,
            sender: {
              select: { displayName: true }
            }
          }
        },
        reactions: {
          include: {
            user: {
              select: { id: true, displayName: true }
            }
          }
        },
        attachments: true
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(parseInt(limit) || 50, 100),
      skip: Math.max(parseInt(offset) || 0, 0)
    });

    const total = await prisma.message.count({
      where: { groupId }
    });

    res.status(200).json({
      success: true,
      data: {
        messages: messages.reverse(),
        total,
        limit: Math.min(parseInt(limit) || 50, 100),
        offset: Math.max(parseInt(offset) || 0, 0)
      }
    });
  } catch (error) {
    console.error('Get group messages error:', error);

    res.status(500).json({
      error: 'Failed to fetch messages',
      code: 'FETCH_ERROR'
    });
  }
});

// ============================================================================
// LEAVE GROUP ENDPOINT
// ============================================================================

router.post('/:groupId/leave', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { groupId } = req.params;

    const member = await prisma.groupMember.findFirst({
      where: {
        groupId,
        userId
      }
    });

    if (!member) {
      return res.status(404).json({
        error: 'You are not a member of this group',
        code: 'NOT_MEMBER'
      });
    }

    const group = await prisma.group.findUnique({
      where: { id: groupId }
    });

    if (group.createdById === userId) {
      return res.status(400).json({
        error: 'Group creator cannot leave. Delete the group instead',
        code: 'CREATOR_CANNOT_LEAVE'
      });
    }

    await prisma.groupMember.delete({
      where: { id: member.id }
    });

    res.status(200).json({
      success: true,
      message: 'You have left the group'
    });
  } catch (error) {
    console.error('Leave group error:', error);

    res.status(500).json({
      error: 'Failed to leave group',
      code: 'LEAVE_ERROR'
    });
  }
});

export default router;
