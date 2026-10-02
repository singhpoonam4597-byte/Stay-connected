import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from './server.js';
import { generateToken, authenticateToken } from './jwt.js';

const router = Router();
const SALT_ROUNDS = 12;

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    displayName: user.displayName,
    avatar: user.avatar ?? null,
    avatarColor: user.avatarColor ?? null,
    bio: user.bio ?? null,
    isPrivate: user.isPrivate ?? false,
    isOnline: user.isOnline ?? false,
    lastSeen: user.lastSeen ?? null,
    createdAt: user.createdAt,
  };
}

function strongPassword(password) {
  if (!password || password.length < 8 || password.length > 128) return false;
  return /[a-zA-Z]/.test(password) && /[0-9]/.test(password);
}

function parseDevice(req) {
  const ua = String(req.headers['user-agent'] || '');
  let deviceName = 'Unknown device';
  if (/iPhone/i.test(ua)) deviceName = 'iPhone';
  else if (/iPad/i.test(ua)) deviceName = 'iPad';
  else if (/Android/i.test(ua)) deviceName = 'Android';
  else if (/Windows/i.test(ua)) deviceName = 'Windows';
  else if (/Mac/i.test(ua)) deviceName = 'Mac';
  else if (/Linux/i.test(ua)) deviceName = 'Linux';
  if (/Chrome/i.test(ua) && !/Edge/i.test(ua)) deviceName += ' · Chrome';
  else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) deviceName += ' · Safari';
  else if (/Firefox/i.test(ua)) deviceName += ' · Firefox';
  else if (/Edge/i.test(ua)) deviceName += ' · Edge';
  const ip =
    (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    null;
  return { deviceName, ipAddress: ip, userAgent: ua.slice(0, 500) };
}

async function createSession(userId, req) {
  const { deviceName, ipAddress, userAgent } = parseDevice(req);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  return prisma.sessionToken.create({
    data: { userId, token, deviceName, ipAddress, userAgent, expiresAt, lastUsedAt: new Date() },
  });
}

router.post('/signup', async (req, res) => {
  try {
    const { email, username, displayName, password, confirmPassword } = req.body || {};
    if (!email?.trim() || !username?.trim() || !displayName?.trim() || !password) {
      return res.status(400).json({ error: 'email, username, displayName and password are required' });
    }
    if (confirmPassword != null && password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }
    if (!strongPassword(password)) {
      return res.status(400).json({ error: 'Password must be 8–128 chars and include a letter and a number' });
    }
    const existing = await prisma.user.findFirst({
      where: { OR: [{ email: email.trim().toLowerCase() }, { username: username.trim().toLowerCase() }] },
    });
    if (existing) return res.status(409).json({ error: 'Email or username already in use' });
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await prisma.user.create({
      data: {
        email: email.trim().toLowerCase(),
        username: username.trim().toLowerCase(),
        displayName: displayName.trim(),
        password: passwordHash,
      },
    });
    const token = generateToken(user);
    let session = null;
    try { session = await createSession(user.id, req); } catch (e) { console.error(e?.message); }
    return res.status(201).json({ success: true, data: { user: publicUser(user), token, sessionId: session?.id || null } });
  } catch (err) {
    console.error('signup error:', err);
    return res.status(500).json({ error: 'Signup failed' });
  }
});

router.post('/login', async (req, res) => {
  try {
    let { email, password } = req.body || {};
    email = typeof email === 'string' ? email.trim().toLowerCase() : '';
    password = typeof password === 'string' ? password : '';
    const passwordTrimmed = password.trim();
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    if (!email.includes('@')) {
      return res.status(400).json({ error: 'Enter a valid email address' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.password) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    let ok = false;
    try {
      ok = await bcrypt.compare(password, user.password);
      if (!ok && passwordTrimmed !== password) {
        ok = await bcrypt.compare(passwordTrimmed, user.password);
      }
    } catch (bcryptErr) {
      console.error('bcrypt.compare failed', bcryptErr?.message);
      return res.status(500).json({ error: 'Login temporarily unavailable. Please try again.' });
    }

    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    let token;
    try {
      token = generateToken(user);
    } catch (tokenErr) {
      console.error('generateToken failed', tokenErr?.message);
      return res.status(500).json({ error: 'Login temporarily unavailable. Please try again.' });
    }

    let session = null;
    try {
      session = await createSession(user.id, req);
    } catch (e) {
      console.error('session create on login', e?.message);
    }

    return res.json({
      success: true,
      data: {
        user: publicUser(user),
        token,
        sessionId: session?.id || null,
      },
    });
  } catch (err) {
    console.error('login error:', err);
    return res.status(500).json({
      error: 'Login temporarily unavailable. Please try again.',
      code: 'LOGIN_ERROR',
    });
  }
});

router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user?.id || req.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({ success: true, data: { user: publicUser(user) } });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to load user' });
  }
});

router.get('/sessions', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const sessions = await prisma.sessionToken.findMany({
      where: { userId, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
      select: { id: true, deviceName: true, ipAddress: true, lastUsedAt: true, createdAt: true, userAgent: true },
    });
    const currentId = req.headers['x-session-id'] || null;
    res.json({
      success: true,
      data: {
        sessions: sessions.map((s) => ({
          ...s,
          isCurrent: currentId && String(s.id) === String(currentId),
        })),
      },
    });
  } catch (err) {
    console.error('list sessions', err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

router.delete('/sessions/:sessionId', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const { sessionId } = req.params;
    const row = await prisma.sessionToken.findFirst({ where: { id: sessionId, userId } });
    if (!row) return res.status(404).json({ error: 'Session not found' });
    await prisma.sessionToken.delete({ where: { id: sessionId } });
    res.json({ success: true });
  } catch (err) {
    console.error('revoke session', err);
    res.status(500).json({ error: 'Failed to revoke session' });
  }
});

router.delete('/sessions', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const currentId = req.headers['x-session-id'] || req.query.currentId;
    if (currentId) {
      await prisma.sessionToken.deleteMany({ where: { userId, id: { not: String(currentId) } } });
    } else {
      await prisma.sessionToken.deleteMany({ where: { userId } });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('revoke all sessions', err);
    res.status(500).json({ error: 'Failed to revoke sessions' });
  }
});

router.post('/change-password', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }
    if (!strongPassword(newPassword)) {
      return res.status(400).json({ error: 'New password must be 8–128 chars and include a letter and a number' });
    }
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.password) return res.status(400).json({ error: 'Account has no password' });
    const ok = await bcrypt.compare(currentPassword, user.password);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await prisma.user.update({ where: { id: userId }, data: { password: passwordHash } });
    res.status(200).json({ success: true, message: 'Password updated' });
  } catch (err) {
    console.error('change-password error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

router.post('/logout', authenticateToken, async (req, res) => {
  try {
    const userId = req.user?.id || req.userId;
    const sessionId = req.headers['x-session-id'] || req.body?.sessionId;
    if (sessionId) {
      try {
        await prisma.sessionToken.deleteMany({ where: { id: String(sessionId), userId } });
      } catch { /* ignore */ }
    }
    try {
      await prisma.user.update({
        where: { id: userId },
        data: { isOnline: false, lastSeen: new Date() },
      });
    } catch { /* ignore */ }
    return res.json({ success: true });
  } catch (err) {
    console.error('logout error:', err);
    return res.status(500).json({ error: 'Logout failed' });
  }
});

export default router;
