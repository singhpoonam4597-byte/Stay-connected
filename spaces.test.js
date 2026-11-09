import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { createSpacesRouter } from './spaces.js';

function fakePrisma() {
  const state = {
    spaces: [],
    members: [],
    invites: [],
    activities: [],
    documents: [],
    notifications: [],
    users: [
      { id: 'owner', username: 'owner', displayName: 'Owner' },
      { id: 'member', username: 'member', displayName: 'Member' },
    ],
    sequence: 0,
  };
  const nextId = (prefix) => `${prefix}-${++state.sequence}`;
  const user = (id) => state.users.find((item) => item.id === id) || null;
  const membership = (spaceId, userId) => state.members.find((item) => item.spaceId === spaceId && item.userId === userId) || null;
  const space = (id) => state.spaces.find((item) => item.id === id) || null;
  const document = (id, spaceId) => state.documents.find((item) => item.id === id && item.spaceId === spaceId) || null;
  const materializeSpace = (item) => ({
    ...item,
    createdBy: user(item.createdById),
    members: state.members.filter((m) => m.spaceId === item.id).map((m) => ({ ...m, user: user(m.userId) })),
    documents: state.documents.filter((d) => d.spaceId === item.id),
    _count: {
      members: state.members.filter((m) => m.spaceId === item.id).length,
      documents: state.documents.filter((d) => d.spaceId === item.id).length,
    },
  });

  const prisma = {
    $transaction: async (work) => work(prisma),
    space: {
      create: async ({ data }) => {
        const record = {
          id: nextId('space'),
          name: data.name,
          description: data.description,
          visibility: data.visibility,
          createdById: data.createdById,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        state.spaces.push(record);
        if (data.members?.create) {
          state.members.push({ id: nextId('member'), spaceId: record.id, ...data.members.create, joinedAt: new Date() });
        }
        return materializeSpace(record);
      },
      findUnique: async ({ where, include }) => {
        const record = space(where.id);
        return record ? (include ? materializeSpace(record) : record) : null;
      },
      findMany: async () => state.spaces.map(materializeSpace),
      count: async () => state.spaces.length,
      update: async ({ where, data }) => {
        const record = space(where.id);
        Object.assign(record, data, { updatedAt: new Date() });
        return materializeSpace(record);
      },
    },
    spaceMember: {
      findUnique: async ({ where }) => {
        const key = where.spaceId_userId;
        return membership(key.spaceId, key.userId);
      },
      upsert: async ({ where, create }) => {
        const key = where.spaceId_userId;
        return membership(key.spaceId, key.userId) || (() => {
          const record = { id: nextId('member'), ...create, joinedAt: new Date() };
          state.members.push(record);
          return record;
        })();
      },
      create: async ({ data }) => {
        const record = { id: nextId('member'), ...data, joinedAt: new Date() };
        state.members.push(record);
        return record;
      },
      update: async ({ where, data }) => {
        const record = state.members.find((item) => item.id === where.id);
        Object.assign(record, data);
        return record;
      },
      delete: async ({ where }) => {
        const index = state.members.findIndex((item) => item.id === where.id);
        return state.members.splice(index, 1)[0];
      },
    },
    spaceInvite: {
      findUnique: async ({ where, include }) => {
        const record = state.invites.find((item) => item.id === where.id) || null;
        return record && include ? { ...record, space: space(record.spaceId) } : record;
      },
      findMany: async ({ where }) => state.invites.filter((item) => item.invitedUserId === where.invitedUserId && item.status === where.status).map((item) => ({
        ...item,
        space: space(item.spaceId),
        invitedBy: user(item.invitedById),
      })),
      upsert: async ({ where, create, update }) => {
        const key = where.spaceId_invitedUserId;
        let record = state.invites.find((item) => item.spaceId === key.spaceId && item.invitedUserId === key.invitedUserId);
        if (record) Object.assign(record, update);
        else {
          record = { id: nextId('invite'), ...create, createdAt: new Date() };
          state.invites.push(record);
        }
        return record;
      },
      update: async ({ where, data }) => {
        const record = state.invites.find((item) => item.id === where.id);
        Object.assign(record, data);
        return record;
      },
      updateMany: async ({ where, data }) => {
        const record = state.invites.find((item) => item.id === where.id && item.invitedUserId === where.invitedUserId && item.status === where.status);
        if (!record) return { count: 0 };
        Object.assign(record, data);
        return { count: 1 };
      },
    },
    spaceActivity: {
      create: async ({ data }) => {
        const record = { id: nextId('activity'), ...data, createdAt: new Date() };
        state.activities.push(record);
        return record;
      },
      findMany: async ({ where }) => state.activities.filter((item) => item.spaceId === where.spaceId),
    },
    spaceDocument: {
      findFirst: async ({ where }) => document(where.id, where.spaceId),
      updateMany: async ({ where, data }) => {
        const record = document(where.id, where.spaceId);
        if (!record || record.version !== where.version) return { count: 0 };
        Object.assign(record, data, { version: record.version + 1 });
        return { count: 1 };
      },
    },
    user: { findUnique: async ({ where }) => user(where.id) },
    blockedUser: { findFirst: async () => null },
    userSettings: { findUnique: async () => null },
    notification: {
      create: async ({ data }) => {
        const record = { id: nextId('notification'), ...data };
        state.notifications.push(record);
        return record;
      },
    },
  };
  return { prisma, state };
}

async function startApi(prisma) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = req.get('x-user-id') || null;
    if (req.userId) req.user = { id: req.userId, username: req.userId };
    next();
  });
  app.use('/api/spaces', createSpacesRouter(prisma));
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}/api/spaces`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function request(api, path, { method = 'GET', userId, body } = {}) {
  const response = await fetch(`${api.base}${path}`, {
    method,
    headers: {
      ...(userId ? { 'x-user-id': userId } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json() };
}

test('Spaces API requires an authenticated user and validates creation input', async (t) => {
  const { prisma } = fakePrisma();
  const api = await startApi(prisma);
  t.after(() => api.close());

  const unauthenticated = await request(api, '/');
  assert.equal(unauthenticated.status, 401);
  const invalid = await request(api, '/', { method: 'POST', userId: 'owner', body: { name: '  ' } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.code, 'SPACE_NAME_REQUIRED');
});

test('Space owners can invite a user, who accepts before private-space access is granted', async (t) => {
  const { prisma, state } = fakePrisma();
  const api = await startApi(prisma);
  t.after(() => api.close());

  const created = await request(api, '/', {
    method: 'POST',
    userId: 'owner',
    body: { name: 'Design room', description: 'Shared work', visibility: 'private' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.data.space.name, 'Design room');
  const spaceId = created.data.data.space.id;
  assert.equal(state.members[0].role, 'owner');

  const denied = await request(api, `/${spaceId}`, { userId: 'member' });
  assert.equal(denied.status, 403);

  const sent = await request(api, `/${spaceId}/invites`, {
    method: 'POST',
    userId: 'owner',
    body: { userId: 'member' },
  });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.data.invite.status, 'pending');
  assert.equal(state.notifications.length, 1);

  const inbox = await request(api, '/invites', { userId: 'member' });
  assert.equal(inbox.status, 200);
  assert.equal(inbox.data.data.invites.length, 1);

  const accepted = await request(api, `/invites/${sent.data.data.invite.id}/accept`, {
    method: 'POST',
    userId: 'member',
  });
  assert.equal(accepted.status, 200);
  assert.equal(state.members.find((item) => item.userId === 'member').role, 'member');

  const allowed = await request(api, `/${spaceId}`, { userId: 'member' });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.data.data.role, 'member');

  const acceptAgain = await request(api, `/invites/${sent.data.data.invite.id}/accept`, {
    method: 'POST',
    userId: 'member',
  });
  assert.equal(acceptAgain.status, 409);
  const declineAfterAccept = await request(api, `/invites/${sent.data.data.invite.id}/decline`, {
    method: 'POST',
    userId: 'member',
  });
  assert.equal(declineAfterAccept.status, 409);
});

test('document edits reject stale versions and return the current document for recovery', async (t) => {
  const { prisma, state } = fakePrisma();
  state.spaces.push({ id: 'space-doc', name: 'Docs', visibility: 'private', createdById: 'owner' });
  state.members.push({ id: 'member-owner', spaceId: 'space-doc', userId: 'owner', role: 'owner' });
  state.documents.push({ id: 'doc-1', spaceId: 'space-doc', title: 'Plan', content: 'Current version', version: 2 });
  const api = await startApi(prisma);
  t.after(() => api.close());

  const result = await request(api, '/space-doc/documents/doc-1', {
    method: 'PATCH',
    userId: 'owner',
    body: { expectedVersion: 1, content: 'Stale overwrite' },
  });
  assert.equal(result.status, 409);
  assert.equal(result.data.code, 'DOCUMENT_VERSION_CONFLICT');
  assert.equal(result.data.data.document.version, 2);
  assert.equal(state.documents[0].content, 'Current version');
});

test('an admin may leave voluntarily but cannot remove another admin', async (t) => {
  const { prisma, state } = fakePrisma();
  state.spaces.push({ id: 'space-admins', name: 'Team', visibility: 'private', createdById: 'owner' });
  state.members.push(
    { id: 'owner-membership', spaceId: 'space-admins', userId: 'owner', role: 'owner' },
    { id: 'admin-membership', spaceId: 'space-admins', userId: 'member', role: 'admin' },
    { id: 'other-admin-membership', spaceId: 'space-admins', userId: 'owner-2', role: 'admin' },
  );
  const api = await startApi(prisma);
  t.after(() => api.close());

  const denied = await request(api, '/space-admins/members/owner-2', {
    method: 'DELETE',
    userId: 'member',
  });
  assert.equal(denied.status, 403);

  const left = await request(api, '/space-admins/members/member', {
    method: 'DELETE',
    userId: 'member',
  });
  assert.equal(left.status, 200);
  assert.equal(state.members.some((item) => item.userId === 'member'), false);
});

test('public-space visitors do not receive internal activity metadata', async (t) => {
  const { prisma, state } = fakePrisma();
  state.spaces.push({ id: 'space-public', name: 'Public', visibility: 'public', createdById: 'owner' });
  state.members.push({ id: 'owner-membership', spaceId: 'space-public', userId: 'owner', role: 'owner' });
  state.activities.push({
    id: 'activity-1',
    spaceId: 'space-public',
    type: 'member_invited',
    detail: 'A member was invited',
    metadata: { invitedUserId: 'member' },
  });
  const api = await startApi(prisma);
  t.after(() => api.close());

  const visitor = await request(api, '/space-public/activity', { userId: 'member' });
  assert.equal(visitor.status, 200);
  assert.equal('metadata' in visitor.data.data.activities[0], false);

  state.members.push({ id: 'visitor-membership', spaceId: 'space-public', userId: 'member', role: 'member' });
  const member = await request(api, '/space-public/activity', { userId: 'member' });
  assert.deepEqual(member.data.data.activities[0].metadata, { invitedUserId: 'member' });
});
