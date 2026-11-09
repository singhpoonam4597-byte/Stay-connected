import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeProfileForViewer } from './userPrivacy.js';

const profileFixture = {
  id: 'user-17',
  username: 'river',
  displayName: 'River Stone',
  avatar: 'https://cdn.example/avatar.png',
  avatarColor: 3,
  bio: 'A private bio',
  isPrivate: true,
  isVerified: true,
  isOnline: true,
  lastSeen: new Date('2026-01-01T00:00:00Z'),
  createdAt: new Date('2025-01-01T00:00:00Z'),
  email: 'river@example.test',
  password: 'never-return-this',
};

test('private profiles expose only basic identity to other users', () => {
  const result = serializeProfileForViewer(profileFixture);
  assert.deepEqual(result, {
    id: 'user-17',
    username: 'river',
    displayName: 'River Stone',
    avatar: 'https://cdn.example/avatar.png',
    avatarColor: 3,
    bio: null,
    isVerified: true,
    isOnline: false,
    lastSeen: null,
    createdAt: profileFixture.createdAt,
    isPrivate: true,
    profileRestricted: true,
  });
  assert.equal('email' in result, false);
  assert.equal('password' in result, false);
});

test('profile owner can still view all their own profile fields', () => {
  const result = serializeProfileForViewer(profileFixture, { isSelf: true });
  assert.equal(result.bio, 'A private bio');
  assert.equal(result.isOnline, true);
  assert.equal(result.lastSeen, profileFixture.lastSeen);
  assert.equal(result.isPrivate, true);
  assert.equal(result.profileRestricted, false);
  assert.equal('password' in result, false);
});

test('public profiles remain visible and respect show-online-status settings', () => {
  const publicProfile = { ...profileFixture, isPrivate: false };
  const visible = serializeProfileForViewer(publicProfile);
  assert.equal(visible.bio, 'A private bio');
  assert.equal(visible.isOnline, true);
  assert.equal(visible.lastSeen, profileFixture.lastSeen);
  assert.equal(visible.profileRestricted, false);

  const presenceHidden = serializeProfileForViewer(publicProfile, { showOnlineStatus: false });
  assert.equal(presenceHidden.bio, 'A private bio');
  assert.equal(presenceHidden.isOnline, false);
  assert.equal(presenceHidden.lastSeen, null);
});
