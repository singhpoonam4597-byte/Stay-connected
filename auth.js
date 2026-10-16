import express from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from './prisma.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { generateToken } from './jwt.js';
import { validateSignup, validateLogin } from './validation.js';
import { authenticateToken } from './jwt.js';

const router = express.Router();

// ============================================================================
// SIGNUP ENDPOINT
// ============================================================================

router.post('/signup', validateSignup, async (req, res) => {
  try {
    const { email, username, displayName, password } = req.body;

    const existingEmail = await prisma.user.findUnique({
      where: { email }
    });

    if (existingEmail) {
      return res.status(409).json({
        error: 'Email already registered',
        code: 'EMAIL_EXISTS'
      });
    }

    const existingUsername = await prisma.user.findUnique({
      where: { username }
    });

    if (existingUsername) {
      return res.status(409).json({
        error: 'Username already taken',
        code: 'USERNAME_EXISTS'
      });
    }

    const hashedPassword = await hashPassword(password);

    const user = await prisma.user.create({
      data: {
        email,
        username,
        displayName: displayName || username,
        password: hashedPassword
      },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        avatar: true,
        createdAt: true
      }
    });

    await prisma.userSettings.create({
      data: { userId: user.id }
    });

    const token = generateToken(user);

    res.status(201).json({
      success: true,
      data: { user, token }
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({
      error: 'Failed to create account',
      code: 'SIGNUP_ERROR'
    });
  }
});

// ============================================================================
// LOGIN ENDPOINT
// ============================================================================

router.post('/login', validateLogin, async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user) {
      return res.status(401).json({
        error: 'Invalid email or password',
        code: 'INVALID_CREDENTIALS'
      });
    }

    const valid = await verifyPassword(password, user.password);
    if (!valid) {
      return res.status(401).json({
        error: 'Invalid email or password',
        code: 'INVALID_CREDENTIALS'
      });
    }

    const token = generateToken(user);

    const { password: _, ...safeUser } = user;

    res.status(200).json({
      success: true,
      data: { user: safeUser, token }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      error: 'Failed to login',
      code: 'LOGIN_ERROR'
    });
  }
});

// ============================================================================
// ME ENDPOINT
// ============================================================================

router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        avatar: true,
        avatarColor: true,
        bio: true,
        isOnline: true,
        lastSeen: true,
        createdAt: true
      }
    });

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        code: 'NOT_FOUND'
      });
    }

    res.status(200).json({
      success: true,
      data: { user }
    });
  } catch (error) {
    console.error('Me error:', error);
    res.status(500).json({
      error: 'Failed to fetch profile',
      code: 'ME_ERROR'
    });
  }
});

router.post('/logout', authenticateToken, async (req, res) => {
  try {
    res.status(200).json({
      success: true,
      message: 'Logged out'
    });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      error: 'Failed to logout',
      code: 'LOGOUT_ERROR'
    });
  }
});

router.post('/refresh', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        avatar: true
      }
    });

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        code: 'NOT_FOUND'
      });
    }

    const token = generateToken(user);

    res.status(200).json({
      success: true,
      data: { token, user }
    });
  } catch (error) {
    console.error('Refresh error:', error);
    res.status(500).json({
      error: 'Failed to refresh token',
      code: 'REFRESH_ERROR'
    });
  }
});

router.get('/sessions', authenticateToken, async (req, res) => {
  try {
    const sessions = await prisma.sessionToken.findMany({
      where: { userId: req.userId },
      orderBy: { lastUsedAt: 'desc' },
      take: 50
    });

    res.status(200).json({
      success: true,
      data: { sessions }
    });
  } catch (error) {
    console.error('Sessions error:', error);
    res.status(500).json({
      error: 'Failed to fetch sessions',
      code: 'SESSIONS_ERROR'
    });
  }
});

router.delete('/sessions/:sessionId', authenticateToken, async (req, res) => {
  try {
    await prisma.sessionToken.deleteMany({
      where: { id: req.params.sessionId, userId: req.userId }
    });
    res.status(200).json({ success: true, message: 'Session revoked' });
  } catch (error) {
    console.error('Revoke session error:', error);
    res.status(500).json({
      error: 'Failed to revoke session',
      code: 'REVOKE_ERROR'
    });
  }
});

router.delete('/sessions', authenticateToken, async (req, res) => {
  try {
    await prisma.sessionToken.deleteMany({
      where: { userId: req.userId }
    });
    res.status(200).json({ success: true, message: 'All sessions revoked' });
  } catch (error) {
    console.error('Revoke all sessions error:', error);
    res.status(500).json({
      error: 'Failed to revoke sessions',
      code: 'REVOKE_ERROR'
    });
  }
});

export default router;

// Named exports for route modules that import middleware from auth.js
export { authenticateToken } from './jwt.js';

export async function requireConversationAccess(req, res, next) {
  try {
    const userId = req.userId || req.user?.id;
    const conversationId = req.params.conversationId;
    if (!userId || !conversationId) {
      return res.status(400).json({ error: 'Missing conversation or user', code: 'BAD_REQUEST' });
    }
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { user1Id: true, user2Id: true },
    });
    if (!conv) {
      return res.status(404).json({ error: 'Conversation not found', code: 'NOT_FOUND' });
    }
    if (conv.user1Id !== userId && conv.user2Id !== userId) {
      return res.status(403).json({ error: 'Not a participant', code: 'FORBIDDEN' });
    }
    req.conversation = conv;
    next();
  } catch (err) {
    console.error('requireConversationAccess', err);
    return res.status(500).json({ error: 'Access check failed', code: 'ACCESS_ERROR' });
  }
}
