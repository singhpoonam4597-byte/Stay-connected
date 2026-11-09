import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import { createServer } from 'node:http';
import { createHomeRouter, getHomeDashboardData } from './home.js';

function createPrismaMock() {
  const calls = {};
  const record = (model, method, result) => async (args) => {
    calls[`${model}.${method}`] = args;
    return result;
  };

  return {
    calls,
    client: {
      user: {
        findUnique: record('user', 'findUnique', {
          id: 'user-1', username: 'casey', displayName: 'Casey', avatar: null, avatarColor: null, bio: null,
        }),
      },
      conversation: {
        findMany: record('conversation', 'findMany', [{
          id: 'conversation-1',
          user1Id: 'user-1',
          user2: { id: 'user-2', username: 'river', displayName: 'River', avatar: null, avatarColor: 2 },
          user1: { id: 'user-1', username: 'casey', displayName: 'Casey', avatar: null, avatarColor: null },
          lastMessage: 'See you soon',
          lastMessageAt: new Date('2026-01-02T03:04:05.000Z'),
          createdAt: new Date('2025-12-01T03:04:05.000Z'),
        }]),
        count: record('conversation', 'count', 3),
      },
      groupMember: {
        findMany: record('groupMember', 'findMany', [{
          role: 'member',
          joinedAt: new Date('2026-01-01T00:00:00.000Z'),
          group: {
            id: 'group-1', name: 'Study circle', description: null, avatar: null,
            lastMessage: 'Notes uploaded', lastMessageAt: null, createdAt: new Date('2025-10-01T00:00:00.000Z'),
          },
        }]),
        count: record('groupMember', 'count', 2),
      },
      notification: {
        findMany: record('notification', 'findMany', [{
          id: 'notice-1', type: 'direct_message', title: 'River', content: 'Hello', link: '/chat/conversation-1',
          read: false, createdAt: new Date('2026-01-02T03:00:00.000Z'),
        }]),
        count: record('notification', 'count', 1),
      },
      attachment: {
        findMany: record('attachment', 'findMany', [{
          id: 'file-1', fileName: 'notes.pdf', fileSize: 1024n, fileType: 'document', mimeType: 'application/pdf',
          fileUrl: 'https://files.example/notes.pdf', thumbnailUrl: null, createdAt: new Date('2026-01-02T02:00:00.000Z'),
        }]),
        count: record('attachment', 'count', 4),
      },
    },
  };
}

async function startApp(app) {
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

test('builds a dashboard from existing records scoped to the signed-in user', async () => {
  const { client, calls } = createPrismaMock();
  const data = await getHomeDashboardData(client, 'user-1');

  assert.equal(data.profile.id, 'user-1');
  assert.equal(data.summary.activeConversations, 3);
  assert.equal(data.summary.activeGroups, 2);
  assert.equal(data.summary.unreadNotifications, 1);
  assert.equal(data.summary.uploadedFiles, 4);
  assert.equal(data.recentConversations[0].contact.id, 'user-2');
  assert.equal(data.recentGroups[0].id, 'group-1');
  assert.equal(data.recentFiles[0].fileSize, 1024);
  assert.equal(calls['user.findUnique'].where.id, 'user-1');
  assert.equal(calls['notification.findMany'].where.userId, 'user-1');
  assert.equal(calls['attachment.findMany'].where.uploadedBy, 'user-1');
  assert.deepEqual(calls['groupMember.findMany'].where, { userId: 'user-1', archivedAt: null });
});

test('rejects a request without an authenticated user identity', async (t) => {
  const { client } = createPrismaMock();
  const app = express();
  app.use('/api/home', createHomeRouter(client));
  const { server, url } = await startApp(app);
  t.after(() => server.close());

  const response = await fetch(`${url}/api/home/dashboard`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'UNAUTHORIZED');
});

test('serves dashboard data for an authenticated identity', async (t) => {
  const { client } = createPrismaMock();
  const app = express();
  app.use((req, _res, next) => {
    req.userId = 'user-1';
    next();
  });
  app.use('/api/home', createHomeRouter(client));
  const { server, url } = await startApp(app);
  t.after(() => server.close());

  const response = await fetch(`${url}/api/home/dashboard`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.data.profile.id, 'user-1');
  assert.equal(payload.data.recentFiles[0].fileSize, 1024);
});
