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

router.post('/signup', async (req, res) => {
  try {
    const { email, username, displayName, password, confirmPassword } = req.body || {};

    if (!email?.trim() || !username?.trim() || !displayName?.trim() || !password) {
      return res.status(400).json({
        error: 'email, username, displayName and password are required',
      });
    }
    if (confirmPassword != null && password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }
    if (!strongPassword(password)) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters and include a letter and a number',
      });
    }
    if (!/^[a-zA-Z0-9_-]{3,50}$/.test(username.trim())) {
      return res.status(400).json({
        error: 'Username must be 3–50 characters: letters, numbers, _ or -',
      });
    }

    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { email: email.trim().toLowerCase() },
          { username: username.trim().toLowerCase() },
        ],
      },
    });
    if (existing) {
      return res.status(409).json({ error: 'Email or username already in use' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    // Schema field is `password` (stores the hash)
    const user = await prisma.user.create({
      data: {
        email: email.trim().toLowerCase(),
        username: username.trim().toLowerCase(),
        displayName: displayName.trim(),
        password: passwordHash,
      },
    });

    const accessToken = generateToken(user);
    const refreshToken = crypto.randomBytes(48).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    try {
      await prisma.sessionToken.create({
        data: { token: refreshToken, userId: user.id, expiresAt },
      });
    } catch {
      /* optional */
    }

    return res.status(201).json({
      success: true,
      data: {
        user: publicUser(user),
        accessToken,
        token: accessToken,
        refreshToken,
      },
    });
  } catch (err) {
    console.error('signup error:', err);
    return res.status(500).json({ error: 'Signup failed' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email?.trim() || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });
    if (!user?.password) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const accessToken = generateToken(user);
    const refreshToken = crypto.randomBytes(48).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    try {
      await prisma.sessionToken.create({
        data: { token: refreshToken, userId: user.id, expiresAt },
      });
    } catch {
      /* optional */
    }

    try {
      await prisma.user.update({
        where: { id: user.id },
        data: { isOnline: true, lastSeen: new Date() },
      });
    } catch {
      /* ignore */
    }

    return res.json({
      success: true,
      data: {
        user: publicUser(user),
        accessToken,
        token: accessToken,
        refreshToken,
      },
    });
  } catch (err) {
    console.error('login error:', err);
    return res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json({ success: true, data: { user: publicUser(user) } });
  } catch (err) {
    console.error('me error:', err);
    return res.status(500).json({ error: 'Failed to load user' });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) {
      return res.status(400).json({ error: 'refreshToken is required' });
    }

    let session;
    try {
      session = await prisma.sessionToken.findUnique({
        where: { token: refreshToken },
        include: { user: true },
      });
    } catch {
      return res.status(401).json({ error: 'Invalid session' });
    }

    if (!session || session.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Session expired' });
    }

    const accessToken = generateToken(session.user);
    return res.json({
      success: true,
      data: {
        user: publicUser(session.user),
        accessToken,
        token: accessToken,
      },
    });
  } catch (err) {
    console.error('refresh error:', err);
    return res.status(500).json({ error: 'Refresh failed' });
  }
});

router.post('/logout', authenticateToken, async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (refreshToken) {
      try {
        await prisma.sessionToken.deleteMany({
          where: { token: refreshToken, userId: req.userId },
        });
      } catch {
        /* ignore */
      }
    }
    try {
      await prisma.user.update({
        where: { id: req.userId },
        data: { isOnline: false, lastSeen: new Date() },
      });
    } catch {
      /* ignore */
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('logout error:', err);
    return res.status(500).json({ error: 'Logout failed' });
  }
});

export default router;
