import express from 'express';

const USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  avatar: true,
  avatarColor: true,
  isVerified: true,
};

const SPACE_INCLUDE = {
  createdBy: { select: USER_SELECT },
  members: {
    include: { user: { select: USER_SELECT } },
    orderBy: { joinedAt: 'asc' },
  },
  _count: { select: { members: true, documents: true } },
};

function currentUserId(req) {
  return req.user?.id || req.userId || null;
}

function pageSize(raw, fallback = 50, maximum = 100) {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function sendError(res, error) {
  return res.status(error.status).json({ error: error.message, code: error.code });
}

async function getAccess(prisma, spaceId, userId, { allowPublicRead = false } = {}) {
  const space = await prisma.space.findUnique({
    where: { id: spaceId },
    select: { id: true, name: true, visibility: true, createdById: true },
  });
  if (!space) return { error: { status: 404, code: 'SPACE_NOT_FOUND', message: 'Space not found' } };

  const member = await prisma.spaceMember.findUnique({
    where: { spaceId_userId: { spaceId, userId } },
  });
  if (!member && !(allowPublicRead && space.visibility === 'public')) {
    return { error: { status: 403, code: 'SPACE_ACCESS_DENIED', message: 'You do not have access to this space' } };
  }
  return { space, member };
}

function canManage(member, space, userId) {
  return Boolean(member && ['owner', 'admin'].includes(member.role)) || space.createdById === userId;
}

async function recordActivity(prisma, { spaceId, actorId, type, detail, metadata }) {
  return prisma.spaceActivity.create({
    data: { spaceId, actorId: actorId || null, type, detail: detail || null, metadata: metadata || undefined },
  });
}

async function runTransaction(prisma, work) {
  return typeof prisma.$transaction === 'function'
    ? prisma.$transaction(work)
    : work(prisma);
}

async function notifySpaceInvite(prisma, io, { invite, space, inviterName }) {
  try {
    const settings = await prisma.userSettings.findUnique({
      where: { userId: invite.invitedUserId },
      select: { notificationsEnabled: true },
    });
    if (settings?.notificationsEnabled === false) return null;

    const notification = await prisma.notification.create({
      data: {
        userId: invite.invitedUserId,
        type: 'space_invite',
        title: `${inviterName || 'A member'} invited you to ${space.name}`.slice(0, 255),
        content: 'Review your invitation to join this CONNECT Space.',
        link: '/spaces',
      },
    });
    if (io) {
      try { io.to(`user:${invite.invitedUserId}`).emit('notification:new', { notification }); } catch (_) {}
    }
    return notification;
  } catch (error) {
    console.warn('Space invite notification failed:', error?.message || error);
    return null;
  }
}

export function createSpacesRouter(prisma) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'NO_USER' });
    const take = pageSize(req.query.limit, 50, 100);
    const skip = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    try {
      const where = { members: { some: { userId } } };
      const [spaces, total] = await Promise.all([
        prisma.space.findMany({
          where,
          include: {
            createdBy: { select: USER_SELECT },
            members: { where: { userId }, select: { role: true, joinedAt: true } },
            _count: { select: { members: true, documents: true } },
          },
          orderBy: { updatedAt: 'desc' },
          take,
          skip,
        }),
        prisma.space.count({ where }),
      ]);
      return res.json({ success: true, data: { spaces, total, limit: take, offset: skip } });
    } catch (error) {
      console.error('List spaces failed:', error?.message || error);
      return res.status(500).json({ error: 'Failed to fetch spaces', code: 'SPACES_FETCH_ERROR' });
    }
  });

  router.post('/', async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'NO_USER' });
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    const visibility = req.body?.visibility === 'public' ? 'public' : 'private';
    if (req.body?.visibility !== undefined && !['private', 'public'].includes(req.body.visibility)) {
      return res.status(400).json({ error: 'Visibility must be private or public', code: 'INVALID_SPACE_VISIBILITY' });
    }
    if (!name) return res.status(400).json({ error: 'Space name is required', code: 'SPACE_NAME_REQUIRED' });
    if (name.length > 80) return res.status(400).json({ error: 'Space name must be 80 characters or fewer', code: 'SPACE_NAME_TOO_LONG' });
    if (description.length > 500) return res.status(400).json({ error: 'Description must be 500 characters or fewer', code: 'SPACE_DESCRIPTION_TOO_LONG' });

    try {
      const space = await runTransaction(prisma, async (tx) => {
        const created = await tx.space.create({
          data: {
            name,
            description: description || null,
            visibility,
            createdById: userId,
            members: { create: { userId, role: 'owner' } },
          },
          include: SPACE_INCLUDE,
        });
        await recordActivity(tx, {
          spaceId: created.id,
          actorId: userId,
          type: 'space_created',
          detail: 'Space created',
        });
        return created;
      });
      return res.status(201).json({ success: true, data: { space } });
    } catch (error) {
      console.error('Create space failed:', error?.message || error);
      return res.status(500).json({ error: 'Failed to create space', code: 'SPACE_CREATE_ERROR' });
    }
  });

  router.get('/discover', async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'NO_USER' });
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
    try {
      const where = {
        visibility: 'public',
        members: { none: { userId } },
        ...(q ? { OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
        ] } : {}),
      };
      const spaces = await prisma.space.findMany({
        where,
        include: {
          createdBy: { select: USER_SELECT },
          _count: { select: { members: true, documents: true } },
        },
        orderBy: { updatedAt: 'desc' },
        take: pageSize(req.query.limit, 30, 50),
      });
      return res.json({ success: true, data: { spaces, query: q } });
    } catch (error) {
      console.error('Discover spaces failed:', error?.message || error);
      return res.status(500).json({ error: 'Failed to discover spaces', code: 'SPACE_DISCOVER_ERROR' });
    }
  });

  router.get('/invites', async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'NO_USER' });
    try {
      const invites = await prisma.spaceInvite.findMany({
        where: { invitedUserId: userId, status: 'pending' },
        include: {
          space: { select: { id: true, name: true, description: true, visibility: true } },
          invitedBy: { select: USER_SELECT },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      return res.json({ success: true, data: { invites } });
    } catch (error) {
      console.error('List space invites failed:', error?.message || error);
      return res.status(500).json({ error: 'Failed to fetch invitations', code: 'SPACE_INVITES_ERROR' });
    }
  });

  router.post('/invites/:inviteId/accept', async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'NO_USER' });
    try {
      const invite = await prisma.spaceInvite.findUnique({
        where: { id: req.params.inviteId },
        include: { space: true },
      });
      if (!invite || invite.invitedUserId !== userId) {
        return res.status(404).json({ error: 'Invitation not found', code: 'INVITE_NOT_FOUND' });
      }
      if (invite.status !== 'pending') {
        return res.status(409).json({ error: 'This invitation is no longer pending', code: 'INVITE_NOT_PENDING' });
      }
      const result = await runTransaction(prisma, async (tx) => {
        const transition = await tx.spaceInvite.updateMany({
          where: { id: invite.id, invitedUserId: userId, status: 'pending' },
          data: { status: 'accepted' },
        });
        if (!transition.count) return null;
        const member = await tx.spaceMember.upsert({
          where: { spaceId_userId: { spaceId: invite.spaceId, userId } },
          create: { spaceId: invite.spaceId, userId, role: 'member' },
          update: {},
        });
        await recordActivity(tx, {
          spaceId: invite.spaceId,
          actorId: userId,
          type: 'member_joined',
          detail: 'A member joined the space',
        });
        return member;
      });
      if (!result) return res.status(409).json({ error: 'This invitation is no longer pending', code: 'INVITE_NOT_PENDING' });
      return res.json({ success: true, data: { member: result, spaceId: invite.spaceId } });
    } catch (error) {
      console.error('Accept space invite failed:', error?.message || error);
      return res.status(500).json({ error: 'Failed to accept invitation', code: 'INVITE_ACCEPT_ERROR' });
    }
  });

  router.post('/invites/:inviteId/decline', async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'NO_USER' });
    try {
      const invite = await prisma.spaceInvite.findUnique({ where: { id: req.params.inviteId } });
      if (!invite || invite.invitedUserId !== userId) {
        return res.status(404).json({ error: 'Invitation not found', code: 'INVITE_NOT_FOUND' });
      }
      if (invite.status !== 'pending') {
        return res.status(409).json({ error: 'This invitation is no longer pending', code: 'INVITE_NOT_PENDING' });
      }
      const transition = await prisma.spaceInvite.updateMany({
        where: { id: invite.id, invitedUserId: userId, status: 'pending' },
        data: { status: 'declined' },
      });
      if (!transition.count) return res.status(409).json({ error: 'This invitation is no longer pending', code: 'INVITE_NOT_PENDING' });
      return res.json({ success: true, data: { inviteId: invite.id, status: 'declined' } });
    } catch (error) {
      console.error('Decline space invite failed:', error?.message || error);
      return res.status(500).json({ error: 'Failed to decline invitation', code: 'INVITE_DECLINE_ERROR' });
    }
  });

  router.post('/:spaceId/join', async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'NO_USER' });
    try {
      const space = await prisma.space.findUnique({ where: { id: req.params.spaceId } });
      if (!space) return res.status(404).json({ error: 'Space not found', code: 'SPACE_NOT_FOUND' });
      if (space.visibility !== 'public') return res.status(403).json({ error: 'This space requires an invitation', code: 'SPACE_INVITE_REQUIRED' });
      const existing = await prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: space.id, userId } },
      });
      if (existing) return res.json({ success: true, data: { member: existing, alreadyMember: true } });
      const member = await prisma.spaceMember.upsert({
        where: { spaceId_userId: { spaceId: space.id, userId } },
        create: { spaceId: space.id, userId, role: 'member' },
        update: {},
      });
      await recordActivity(prisma, {
        spaceId: space.id,
        actorId: userId,
        type: 'member_joined',
        detail: 'A member joined the space',
      });
      return res.status(201).json({ success: true, data: { member, alreadyMember: false } });
    } catch (error) {
      console.error('Join public space failed:', error?.message || error);
      return res.status(500).json({ error: 'Failed to join space', code: 'SPACE_JOIN_ERROR' });
    }
  });

  router.get('/:spaceId', async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'NO_USER' });
    try {
      const access = await getAccess(prisma, req.params.spaceId, userId, { allowPublicRead: true });
      if (access.error) return sendError(res, access.error);
      const space = await prisma.space.findUnique({
        where: { id: req.params.spaceId },
        include: {
          ...SPACE_INCLUDE,
          documents: {
            orderBy: { updatedAt: 'desc' },
            take: 50,
            select: {
              id: true,
              title: true,
              version: true,
              createdById: true,
              updatedById: true,
              createdAt: true,
              updatedAt: true,
              createdBy: { select: USER_SELECT },
              updatedBy: { select: USER_SELECT },
            },
          },
        },
      });
      return res.json({ success: true, data: { space, role: access.member?.role || 'visitor' } });
    } catch (error) {
      console.error('Get space failed:', error?.message || error);
      return res.status(500).json({ error: 'Failed to fetch space', code: 'SPACE_FETCH_ERROR' });
    }
  });

  router.patch('/:spaceId', async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'NO_USER' });
    try {
      const access = await getAccess(prisma, req.params.spaceId, userId);
      if (access.error) return sendError(res, access.error);
      if (!canManage(access.member, access.space, userId)) {
        return res.status(403).json({ error: 'Owner or admin permissions required', code: 'SPACE_ADMIN_REQUIRED' });
      }
      const update = {};
      if (req.body?.name !== undefined) {
        if (typeof req.body.name !== 'string' || !req.body.name.trim() || req.body.name.trim().length > 80) {
          return res.status(400).json({ error: 'Space name must be 1–80 characters', code: 'INVALID_SPACE_NAME' });
        }
        update.name = req.body.name.trim();
      }
      if (req.body?.description !== undefined) {
        if (typeof req.body.description !== 'string' || req.body.description.trim().length > 500) {
          return res.status(400).json({ error: 'Description must be 500 characters or fewer', code: 'INVALID_SPACE_DESCRIPTION' });
        }
        update.description = req.body.description.trim() || null;
      }
      if (req.body?.visibility !== undefined) {
        if (!['private', 'public'].includes(req.body.visibility)) {
          return res.status(400).json({ error: 'Visibility must be private or public', code: 'INVALID_SPACE_VISIBILITY' });
        }
        update.visibility = req.body.visibility;
      }
      if (!Object.keys(update).length) return res.status(400).json({ error: 'No supported fields to update', code: 'NO_SPACE_CHANGES' });
      const space = await prisma.space.update({ where: { id: access.space.id }, data: update, include: SPACE_INCLUDE });
      await recordActivity(prisma, {
        spaceId: space.id,
        actorId: userId,
        type: 'space_updated',
        detail: 'Space settings updated',
        metadata: { fields: Object.keys(update) },
      });
      return res.json({ success: true, data: { space } });
    } catch (error) {
      console.error('Update space failed:', error?.message || error);
      return res.status(500).json({ error: 'Failed to update space', code: 'SPACE_UPDATE_ERROR' });
    }
  });

  router.post('/:spaceId/invites', async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'NO_USER' });
    const invitedUserId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : '';
    if (!invitedUserId) return res.status(400).json({ error: 'A user ID is required', code: 'INVITEE_REQUIRED' });
    if (invitedUserId === userId) return res.status(400).json({ error: 'You cannot invite yourself', code: 'SELF_INVITE' });
    try {
      const access = await getAccess(prisma, req.params.spaceId, userId);
      if (access.error) return sendError(res, access.error);
      if (!canManage(access.member, access.space, userId)) {
        return res.status(403).json({ error: 'Owner or admin permissions required', code: 'SPACE_ADMIN_REQUIRED' });
      }
      const invitee = await prisma.user.findUnique({ where: { id: invitedUserId }, select: USER_SELECT });
      if (!invitee) return res.status(404).json({ error: 'User not found', code: 'INVITEE_NOT_FOUND' });
      const blocked = await prisma.blockedUser.findFirst({
        where: { OR: [
          { blockerId: userId, blockedId: invitedUserId },
          { blockerId: invitedUserId, blockedId: userId },
        ] },
        select: { id: true },
      });
      if (blocked) return res.status(403).json({ error: 'You cannot invite this user', code: 'INVITEE_BLOCKED' });
      const member = await prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: access.space.id, userId: invitedUserId } },
      });
      if (member) return res.status(409).json({ error: 'This user is already a member', code: 'ALREADY_MEMBER' });

      const invite = await prisma.spaceInvite.upsert({
        where: { spaceId_invitedUserId: { spaceId: access.space.id, invitedUserId } },
        create: { spaceId: access.space.id, invitedById: userId, invitedUserId, status: 'pending' },
        update: { invitedById: userId, status: 'pending' },
      });
      await recordActivity(prisma, {
        spaceId: access.space.id,
        actorId: userId,
        type: 'member_invited',
        detail: 'A member was invited',
      });
      const inviterName = req.user?.displayName || req.user?.username || 'A member';
      const io = req.app?.get?.('io');
      await notifySpaceInvite(prisma, io, { invite, space: access.space, inviterName });
      return res.status(201).json({ success: true, data: { invite, invitee } });
    } catch (error) {
      console.error('Invite to space failed:', error?.message || error);
      return res.status(500).json({ error: 'Failed to invite user', code: 'SPACE_INVITE_ERROR' });
    }
  });

  router.patch('/:spaceId/members/:memberId', async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'NO_USER' });
    const role = req.body?.role;
    if (!['admin', 'member'].includes(role)) {
      return res.status(400).json({ error: 'Role must be admin or member', code: 'INVALID_SPACE_ROLE' });
    }
    try {
      const access = await getAccess(prisma, req.params.spaceId, userId);
      if (access.error) return sendError(res, access.error);
      if (!canManage(access.member, access.space, userId)) {
        return res.status(403).json({ error: 'Owner or admin permissions required', code: 'SPACE_ADMIN_REQUIRED' });
      }
      const target = await prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: access.space.id, userId: req.params.memberId } },
      });
      if (!target) return res.status(404).json({ error: 'Member not found', code: 'SPACE_MEMBER_NOT_FOUND' });
      const actorIsOwner = access.member?.role === 'owner' || access.space.createdById === userId;
      if (target.role === 'owner') return res.status(403).json({ error: 'Owner role cannot be changed here', code: 'OWNER_ROLE_PROTECTED' });
      if (!actorIsOwner && (target.role === 'admin' || role === 'admin')) {
        return res.status(403).json({ error: 'Only the owner can manage admin roles', code: 'OWNER_REQUIRED' });
      }
      const member = await prisma.spaceMember.update({ where: { id: target.id }, data: { role } });
      await recordActivity(prisma, {
        spaceId: access.space.id,
        actorId: userId,
        type: 'member_role_changed',
        detail: 'A member role was changed',
        metadata: { memberId: req.params.memberId, role },
      });
      return res.json({ success: true, data: { member } });
    } catch (error) {
      console.error('Update space member role failed:', error?.message || error);
      return res.status(500).json({ error: 'Failed to update member role', code: 'SPACE_ROLE_ERROR' });
    }
  });

  router.delete('/:spaceId/members/:memberId', async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'NO_USER' });
    try {
      const access = await getAccess(prisma, req.params.spaceId, userId);
      if (access.error) return sendError(res, access.error);
      const target = await prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: access.space.id, userId: req.params.memberId } },
      });
      if (!target) return res.status(404).json({ error: 'Member not found', code: 'SPACE_MEMBER_NOT_FOUND' });
      const actorIsOwner = access.member?.role === 'owner' || access.space.createdById === userId;
      const isSelfLeave = req.params.memberId === userId;
      if (!isSelfLeave && !canManage(access.member, access.space, userId)) {
        return res.status(403).json({ error: 'Owner or admin permissions required', code: 'SPACE_ADMIN_REQUIRED' });
      }
      if (target.role === 'owner') return res.status(403).json({ error: 'Transfer ownership before leaving or removing the owner', code: 'OWNER_ROLE_PROTECTED' });
      if (!isSelfLeave && !actorIsOwner && target.role === 'admin') {
        return res.status(403).json({ error: 'Only the owner can remove an admin', code: 'OWNER_REQUIRED' });
      }
      await prisma.spaceMember.delete({ where: { id: target.id } });
      await recordActivity(prisma, {
        spaceId: access.space.id,
        actorId: userId,
        type: isSelfLeave ? 'member_left' : 'member_removed',
        detail: isSelfLeave ? 'A member left the space' : 'A member was removed',
        metadata: { memberId: req.params.memberId },
      });
      return res.json({ success: true, data: { removedUserId: req.params.memberId } });
    } catch (error) {
      console.error('Remove space member failed:', error?.message || error);
      return res.status(500).json({ error: 'Failed to update space membership', code: 'SPACE_MEMBER_ERROR' });
    }
  });

  router.get('/:spaceId/documents', async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'NO_USER' });
    try {
      const access = await getAccess(prisma, req.params.spaceId, userId, { allowPublicRead: true });
      if (access.error) return sendError(res, access.error);
      const take = pageSize(req.query.limit, 50, 100);
      const skip = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
      const documents = await prisma.spaceDocument.findMany({
        where: { spaceId: access.space.id },
        orderBy: { updatedAt: 'desc' },
        take,
        skip,
        select: {
          id: true,
          title: true,
          version: true,
          createdById: true,
          updatedById: true,
          createdAt: true,
          updatedAt: true,
          createdBy: { select: USER_SELECT },
          updatedBy: { select: USER_SELECT },
        },
      });
      return res.json({ success: true, data: { documents, limit: take, offset: skip } });
    } catch (error) {
      console.error('List space documents failed:', error?.message || error);
      return res.status(500).json({ error: 'Failed to fetch shared documents', code: 'SPACE_DOCUMENTS_ERROR' });
    }
  });

  router.get('/:spaceId/documents/:documentId', async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'NO_USER' });
    try {
      const access = await getAccess(prisma, req.params.spaceId, userId, { allowPublicRead: true });
      if (access.error) return sendError(res, access.error);
      const document = await prisma.spaceDocument.findFirst({
        where: { id: req.params.documentId, spaceId: access.space.id },
        include: { createdBy: { select: USER_SELECT }, updatedBy: { select: USER_SELECT } },
      });
      if (!document) return res.status(404).json({ error: 'Document not found', code: 'SPACE_DOCUMENT_NOT_FOUND' });
      return res.json({ success: true, data: { document } });
    } catch (error) {
      console.error('Get space document failed:', error?.message || error);
      return res.status(500).json({ error: 'Failed to fetch shared document', code: 'SPACE_DOCUMENT_FETCH_ERROR' });
    }
  });

  router.post('/:spaceId/documents', async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'NO_USER' });
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    if (!title || title.length > 120) return res.status(400).json({ error: 'Document title must be 1–120 characters', code: 'INVALID_DOCUMENT_TITLE' });
    if (content.length > 100000) return res.status(400).json({ error: 'Document content exceeds 100,000 characters', code: 'DOCUMENT_TOO_LARGE' });
    try {
      const access = await getAccess(prisma, req.params.spaceId, userId);
      if (access.error) return sendError(res, access.error);
      const document = await prisma.spaceDocument.create({
        data: { spaceId: access.space.id, title, content, createdById: userId, updatedById: userId },
        include: { createdBy: { select: USER_SELECT }, updatedBy: { select: USER_SELECT } },
      });
      await recordActivity(prisma, {
        spaceId: access.space.id,
        actorId: userId,
        type: 'document_created',
        detail: 'A shared document was created',
        metadata: { documentId: document.id, title: document.title },
      });
      return res.status(201).json({ success: true, data: { document } });
    } catch (error) {
      console.error('Create space document failed:', error?.message || error);
      return res.status(500).json({ error: 'Failed to create shared document', code: 'SPACE_DOCUMENT_CREATE_ERROR' });
    }
  });

  router.patch('/:spaceId/documents/:documentId', async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'NO_USER' });
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      return res.status(400).json({ error: 'A valid expectedVersion is required', code: 'DOCUMENT_VERSION_REQUIRED' });
    }
    const update = { updatedById: userId, updatedAt: new Date(), version: { increment: 1 } };
    if (req.body?.title !== undefined) {
      if (typeof req.body.title !== 'string' || !req.body.title.trim() || req.body.title.trim().length > 120) {
        return res.status(400).json({ error: 'Document title must be 1–120 characters', code: 'INVALID_DOCUMENT_TITLE' });
      }
      update.title = req.body.title.trim();
    }
    if (req.body?.content !== undefined) {
      if (typeof req.body.content !== 'string' || req.body.content.length > 100000) {
        return res.status(400).json({ error: 'Document content exceeds 100,000 characters', code: 'DOCUMENT_TOO_LARGE' });
      }
      update.content = req.body.content;
    }
    if (Object.keys(update).every((key) => ['updatedById', 'updatedAt', 'version'].includes(key))) {
      return res.status(400).json({ error: 'No document changes were provided', code: 'NO_DOCUMENT_CHANGES' });
    }
    try {
      const access = await getAccess(prisma, req.params.spaceId, userId);
      if (access.error) return sendError(res, access.error);
      const result = await prisma.spaceDocument.updateMany({
        where: { id: req.params.documentId, spaceId: access.space.id, version: expectedVersion },
        data: update,
      });
      if (!result.count) {
        const current = await prisma.spaceDocument.findFirst({
          where: { id: req.params.documentId, spaceId: access.space.id },
          include: { createdBy: { select: USER_SELECT }, updatedBy: { select: USER_SELECT } },
        });
        if (!current) return res.status(404).json({ error: 'Document not found', code: 'SPACE_DOCUMENT_NOT_FOUND' });
        return res.status(409).json({ error: 'Document changed since you opened it', code: 'DOCUMENT_VERSION_CONFLICT', data: { document: current } });
      }
      const document = await prisma.spaceDocument.findFirst({
        where: { id: req.params.documentId, spaceId: access.space.id },
        include: { createdBy: { select: USER_SELECT }, updatedBy: { select: USER_SELECT } },
      });
      await recordActivity(prisma, {
        spaceId: access.space.id,
        actorId: userId,
        type: 'document_updated',
        detail: 'A shared document was updated',
        metadata: { documentId: document.id, version: document.version },
      });
      return res.json({ success: true, data: { document } });
    } catch (error) {
      console.error('Update space document failed:', error?.message || error);
      return res.status(500).json({ error: 'Failed to update shared document', code: 'SPACE_DOCUMENT_UPDATE_ERROR' });
    }
  });

  router.delete('/:spaceId/documents/:documentId', async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'NO_USER' });
    try {
      const access = await getAccess(prisma, req.params.spaceId, userId);
      if (access.error) return sendError(res, access.error);
      const document = await prisma.spaceDocument.findFirst({
        where: { id: req.params.documentId, spaceId: access.space.id },
        select: { id: true, title: true, createdById: true },
      });
      if (!document) return res.status(404).json({ error: 'Document not found', code: 'SPACE_DOCUMENT_NOT_FOUND' });
      if (document.createdById !== userId && !canManage(access.member, access.space, userId)) {
        return res.status(403).json({ error: 'Only the document creator or a space admin can delete it', code: 'DOCUMENT_DELETE_DENIED' });
      }
      await prisma.spaceDocument.delete({ where: { id: document.id } });
      await recordActivity(prisma, {
        spaceId: access.space.id,
        actorId: userId,
        type: 'document_deleted',
        detail: 'A shared document was deleted',
        metadata: { documentId: document.id, title: document.title },
      });
      return res.json({ success: true, data: { deletedDocumentId: document.id } });
    } catch (error) {
      console.error('Delete space document failed:', error?.message || error);
      return res.status(500).json({ error: 'Failed to delete shared document', code: 'SPACE_DOCUMENT_DELETE_ERROR' });
    }
  });

  router.get('/:spaceId/activity', async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized', code: 'NO_USER' });
    try {
      const access = await getAccess(prisma, req.params.spaceId, userId, { allowPublicRead: true });
      if (access.error) return sendError(res, access.error);
      const activities = await prisma.spaceActivity.findMany({
        where: { spaceId: access.space.id },
        include: { actor: { select: USER_SELECT } },
        orderBy: { createdAt: 'desc' },
        take: pageSize(req.query.limit, 50, 100),
      });
      const visibleActivities = access.member
        ? activities
        : activities.map(({ metadata, ...activity }) => activity);
      return res.json({ success: true, data: { activities: visibleActivities } });
    } catch (error) {
      console.error('Get space activity failed:', error?.message || error);
      return res.status(500).json({ error: 'Failed to fetch space activity', code: 'SPACE_ACTIVITY_ERROR' });
    }
  });

  return router;
}

export default createSpacesRouter;
