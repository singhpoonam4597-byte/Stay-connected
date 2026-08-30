import express from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from './server.js';
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
        password: hashedPassword,
        avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=${username}`,
        settings: {
          create: {
            theme: 'dark',
            language: 'en'
          }
        }
      },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        avatar: true,
        isOnline: true,
        createdAt: true
      }
    });

    const token = generateToken(user);

    const sessionToken = await prisma.sessionToken.create({
      data: {
        userId: user.id,
        token: token,
        deviceName: req.headers['user-agent']?.substring(0, 100),
        ipAddress: req.ip,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      }
    });

    res.status(201).json({
      success: true,
      data: {
        user,
        token,
        expiresIn: '7d'
      }
    });
  } catch (error) {
    console.error('Signup error:', error);

    res.status(500).json({
      error: 'Signup failed',
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
      where: { email },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        avatar: true,
        password: true,
        isOnline: true,
        createdAt: true
      }
    });

    if (!user) {
      return res.status(401).json({
        error: 'Invalid email or password',
        code: 'INVALID_CREDENTIALS'
      });
    }

    const validPassword = await verifyPassword(password, user.password);

    if (!validPassword) {
      return res.status(401).json({
        error: 'Invalid email or password',
        code: 'INVALID_CREDENTIALS'
      });
    }

    const token = generateToken(user);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        isOnline: true,
        lastActive: new Date()
      }
    });

    const sessionToken = await prisma.sessionToken.create({
      data: {
        userId: user.id,
        token: token,
        deviceName: req.headers['user-agent']?.substring(0, 100),
        ipAddress: req.ip,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      }
    });

    const { password: _, ...userWithoutPassword } = user;

    res.status(200).json({
      success: true,
      data: {
        user: userWithoutPassword,
        token,
        expiresIn: '7d'
      }
    });
  } catch (error) {
    console.error('Login error:', error);

    res.status(500).json({
      error: 'Login failed',
      code: 'LOGIN_ERROR'
    });
  }
});

// ============================================================================
// GET CURRENT USER ENDPOINT
// ============================================================================

router.get('/me', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        avatar: true,
        bio: true,
        isPrivate: true,
        isVerified: true,
        isOnline: true,
        lastSeen: true,
        lastActive: true,
        createdAt: true,
        settings: true,
        _count: {
          select: {
            friendships: true,
            sentConversations: true,
            groupMemberships: true,
            notifications: {
              where: { read: false }
            }
          }
        }
      }
    });

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    res.status(200).json({
      success: true,
      data: user
    });
  } catch (error) {
    console.error('Get current user error:', error);

    res.status(500).json({
      error: 'Failed to fetch user',
      code: 'FETCH_ERROR'
    });
  }
});

// ============================================================================
// LOGOUT ENDPOINT
// ============================================================================

router.post('/logout', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
      await prisma.sessionToken.deleteMany({
        where: {
          userId,
          token
        }
      });
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        isOnline: false,
        lastSeen: new Date()
      }
    });

    res.status(200).json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    console.error('Logout error:', error);

    res.status(500).json({
      error: 'Logout failed',
      code: 'LOGOUT_ERROR'
    });
  }
});

// ============================================================================
// REFRESH TOKEN ENDPOINT
// ============================================================================

router.post('/refresh', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        username: true
      }
    });

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    const newToken = generateToken(user);

    const oldAuthHeader = req.headers['authorization'];
    const oldToken = oldAuthHeader && oldAuthHeader.split(' ')[1];

    if (oldToken) {
      await prisma.sessionToken.deleteMany({
        where: {
          userId,
          token: oldToken
        }
      });
    }

    await prisma.sessionToken.create({
      data: {
        userId,
        token: newToken,
        deviceName: req.headers['user-agent']?.substring(0, 100),
        ipAddress: req.ip,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      }
    });

    res.status(200).json({
      success: true,
      data: {
        token: newToken,
        expiresIn: '7d'
      }
    });
  } catch (error) {
    console.error('Token refresh error:', error);

    res.status(500).json({
      error: 'Token refresh failed',
      code: 'REFRESH_ERROR'
    });
  }
});

// ============================================================================
// GET ALL SESSIONS ENDPOINT
// ============================================================================

router.get('/sessions', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;

    const sessions = await prisma.sessionToken.findMany({
      where: { userId },
      select: {
        id: true,
        deviceName: true,
        ipAddress: true,
        lastUsedAt: true,
        createdAt: true,
        expiresAt: true
      },
      orderBy: { lastUsedAt: 'desc' }
    });

    res.status(200).json({
      success: true,
      data: {
        sessions,
        count: sessions.length
      }
    });
  } catch (error) {
    console.error('Get sessions error:', error);

    res.status(500).json({
      error: 'Failed to fetch sessions',
      code: 'FETCH_ERROR'
    });
  }
});

// ============================================================================
// REVOKE SESSION ENDPOINT
// ============================================================================

router.delete('/sessions/:sessionId', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { sessionId } = req.params;

    const session = await prisma.sessionToken.findUnique({
      where: { id: sessionId }
    });

    if (!session) {
      return res.status(404).json({
        error: 'Session not found',
        code: 'NOT_FOUND'
      });
    }

    if (session.userId !== userId) {
      return res.status(403).json({
        error: 'You can only revoke your own sessions',
        code: 'NOT_AUTHORIZED'
      });
    }

    await prisma.sessionToken.delete({
      where: { id: sessionId }
    });

    res.status(200).json({
      success: true,
      message: 'Session revoked'
    });
  } catch (error) {
    console.error('Revoke session error:', error);

    res.status(500).json({
      error: 'Failed to revoke session',
      code: 'REVOKE_ERROR'
    });
  }
});

// ============================================================================
// REVOKE ALL SESSIONS ENDPOINT
// ============================================================================

router.delete('/sessions', authenticateToken, async (req, res) => {
  try {
    const userId = req.userId;

    await prisma.sessionToken.deleteMany({
      where: { userId }
    });

    await prisma.user.update({
      where: { id: userId },
      data: {
        isOnline: false,
        lastSeen: new Date()
      }
    });

    res.status(200).json({
      success: true,
      message: 'All sessions revoked'
    });
  } catch (error) {
    console.error('Revoke all sessions error:', error);

    res.status(500).json({
      error: 'Failed to revoke sessions',
      code: 'REVOKE_ERROR'
    });
  }
});

export default router;
