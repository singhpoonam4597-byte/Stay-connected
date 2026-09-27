import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';

import authRoutes from './authRoutes.js';
import userRoutes from './users.js';
import messageRoutes from './messages.js';
import conversationRoutes from './conversations.js';
import groupRoutes from './groups.js';
import uploadRoutes from './upload.js';
import settingsRoutes from './settings.js';
import { authenticateToken } from './jwt.js';
import { errorHandler } from './errorHandler.js';
import { initChatHandler } from './chatHandler.js';
import { initPresenceHandler } from './presenceHandler.js';

dotenv.config();

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must be set and at least 32 characters');
  process.exit(1);
}

const app = express();
const httpServer = createServer(app);

// Comma-separated list supported, e.g. https://a.vercel.app,https://b.vercel.app
const FRONTEND_URLS = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const corsOrigin = (origin, cb) => {
  // Allow non-browser tools (no Origin) and listed frontends
  if (!origin || FRONTEND_URLS.includes(origin)) {
    return cb(null, true);
  }
  // Also allow any *.vercel.app preview while launching (tighten later)
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) {
    return cb(null, true);
  }
  return cb(new Error(`CORS blocked: ${origin}`));
};

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: corsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  },
  path: process.env.SOCKET_PATH || '/socket.io',
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 60000,
});

app.set('io', io);

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 200,
  })
);

if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
}

const generalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many authentication attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'development',
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  message: 'Too many file uploads, please try again later.',
});

app.use('/api/', generalLimiter);

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    uptime: process.uptime(),
    allowedFrontends: FRONTEND_URLS,
  });
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);
app.use('/api/auth', authRoutes);

app.use('/api/users', authenticateToken, userRoutes);
app.use('/api/messages', authenticateToken, messageRoutes);
app.use('/api/conversations', authenticateToken, conversationRoutes);
app.use('/api/groups', authenticateToken, groupRoutes);
app.use('/api/upload', authenticateToken, uploadLimiter, uploadRoutes);
app.use('/api/settings', authenticateToken, settingsRoutes);

io.use(async (socket, next) => {
  try {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.query?.token ||
      (socket.handshake.headers?.authorization || '').replace(/^Bearer\s+/i, '');

    if (!token) return next(new Error('Authentication error'));

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = decoded.id || decoded.userId || decoded.sub;
    socket.userEmail = decoded.email;
    socket.username = decoded.username;
    if (!socket.userId) return next(new Error('Authentication error'));
    next();
  } catch {
    next(new Error('Authentication error'));
  }
});

initChatHandler(io, prisma);
initPresenceHandler(io, prisma);

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.userId} (${socket.id})`);
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.userId} (${socket.id})`);
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.path,
    method: req.method,
  });
});

app.use(errorHandler);

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';

httpServer.listen(PORT, HOST, () => {
  console.log('='.repeat(50));
  console.log('Connect backend started');
  console.log(`Listening on ${HOST}:${PORT}`);
  console.log(`FRONTEND_URLS: ${FRONTEND_URLS.join(', ')}`);
  console.log(`NODE_ENV: ${process.env.NODE_ENV}`);
  console.log('='.repeat(50));
});

process.on('SIGINT', async () => {
  httpServer.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
});

process.on('SIGTERM', async () => {
  httpServer.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

export { app, httpServer, io };
