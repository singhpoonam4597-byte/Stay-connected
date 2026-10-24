import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';

import authRoutes from './authRoutes.js';
import userRoutes from './users.js';
import messageRoutes from './messages.js';
import conversationRoutes from './conversations.js';
import groupRoutes from './groups.js';
import uploadRoutes from './upload.js';
import settingsRoutes from './settings.js';
import aiRoutes from './ai.js';
import { authenticateToken } from './jwt.js';
import { errorHandler } from './errorHandler.js';
import { initChatHandler } from './chatHandler.js';
import { initPresenceHandler } from './presenceHandler.js';
import { prisma } from './prisma.js';
import { rateLimit as memLimit } from './scale.js';

dotenv.config();

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must be set and at least 32 characters');
  process.exit(1);
}

const app = express();
const httpServer = createServer(app);

const FRONTEND_URLS = (process.env.FRONTEND_URL || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const corsOrigin = (origin, cb) => {
  if (!origin || FRONTEND_URLS.includes(origin)) return cb(null, true);
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) return cb(null, true);
  return cb(new Error(`CORS blocked: ${origin}`));
};

const io = new SocketIOServer(httpServer, {
  cors: { origin: corsOrigin, credentials: true, methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
  path: process.env.SOCKET_PATH || '/socket.io',
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e6,
  connectTimeout: 20000,
  perMessageDeflate: false,
  httpCompression: true,
  allowEIO3: false,
});

app.set('io', io);
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ limit: '2mb', extended: true }));
app.use(cors({
  origin: corsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Id'],
  optionsSuccessStatus: 200,
}));

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 2000, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests, please try again later', code: 'RATE_LIMIT' },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in 15 minutes.', code: 'AUTH_RATE_LIMIT' },
});
const uploadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 80, standardHeaders: true, legacyHeaders: false });
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many AI requests. Please wait.', code: 'AI_RATE_LIMIT' },
});

function messageSendLimiter(req, res, next) {
  const uid = req.userId || req.user?.id || req.ip;
  const r = memLimit(`msg:${uid}`, { limit: 60, windowMs: 60_000 });
  if (!r.ok) {
    return res.status(429).json({ error: 'Sending too fast. Please wait a moment.', code: 'MSG_RATE_LIMIT', retryAfterMs: r.retryAfterMs });
  }
  next();
}

app.use('/api/', generalLimiter);
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    uptime: process.uptime(),
    allowedFrontends: FRONTEND_URLS,
    connections: io.engine?.clientsCount ?? null,
  });
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/users', authenticateToken, userRoutes);
app.use('/api/messages', authenticateToken, messageSendLimiter, messageRoutes);
app.use('/api/conversations', authenticateToken, conversationRoutes);
app.use('/api/groups', authenticateToken, groupRoutes);
app.use('/api/upload', authenticateToken, uploadLimiter, uploadRoutes);
app.use('/api/settings', authenticateToken, settingsRoutes);
app.use('/api/ai', authenticateToken, aiLimiter, aiRoutes);

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
  if (socket.userId) socket.join(`user:${socket.userId}`);
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found', path: req.path, method: req.method });
});
app.use(errorHandler);

const PORT = parseInt(process.env.PORT || '3000', 10);
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Connect backend on 0.0.0.0:${PORT}`);
});

async function shutdown(signal) {
  httpServer.close(async () => {
    try { await prisma.$disconnect(); } catch (_) {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref?.();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, httpServer, io, prisma };
