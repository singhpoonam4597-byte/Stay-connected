import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';

import {
  authRoutes,
  authenticateToken,
  userRoutes,
  messageRoutes,
  conversationRoutes,
  groupRoutes,
  uploadRoutes,
  settingsRoutes,
  aiRoutes,
  notificationRoutes,
  initChatHandler,
  initPresenceHandler,
  errorHandler,
  rateLimit as memLimit,
  prisma,
} from './modules/index.js';
import oneToOneRoutes, { initOneToOneCallHandler, startOneToOneMaintenance } from './oneToOneFeatures.js';
import { startOneToOneDataSafety } from './oneToOneDataSafety.js';

dotenv.config();

if (!process.env.JWT\_SECRET || process.env.JWT\_SECRET.length &lt; 32) {
  console.error('JWT\_SECRET must be set and at least 32 characters');
  process.exit(1);
}

const app = express();
const httpServer = createServer(app);

const FRONTEND\_URLS = (process.env.FRONTEND\_URL || '[http://localhost:5173](http://localhost:5173)')
  .split(',')
  .map((s) =&gt; s.trim().replace(//+$/, ''))
  .filter(Boolean);

const corsOrigin = (origin, cb) =&gt; {
  if (!origin || FRONTEND\_URLS.includes(origin)) return cb(null, true);
  if (/^https://\[a-z0-9-\]+.vercel.app$/i.test(origin)) return cb(null, true);
  return cb(new Error(`CORS blocked: ${origin}`));
};

const io = new SocketIOServer(httpServer, {
  cors: { origin: corsOrigin, credentials: true, methods: \['GET', 'POST', 'PUT', 'DELETE', 'PATCH'\] },
  path: process.env.SOCKET\_PATH || '/socket.io',
  transports: \['websocket', 'polling'\],
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
  methods: \['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'\],
  allowedHeaders: \['Content-Type', 'Authorization', 'X-Session-Id'\],
  optionsSuccessStatus: 200,
}));

const generalLimiter = rateLimit({
  windowMs: 15 \* 60 \* 1000, max: 2000, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests, please try again later', code: 'RATE\_LIMIT' },
});
const authLimiter = rateLimit({
  windowMs: 15 \* 60 \* 1000, max: 40, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in 15 minutes.', code: 'AUTH\_RATE\_LIMIT' },
});
const messageSendLimiter = rateLimit({
  windowMs: 60 \* 1000, max: 120, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Sending too fast. Please slow down.', code: 'MESSAGE\_RATE\_LIMIT' },
});
const uploadLimiter = rateLimit({
  windowMs: 15 \* 60 \* 1000, max: 80, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many uploads. Try again later.', code: 'UPLOAD\_RATE\_LIMIT' },
});
const aiLimiter = rateLimit({
  windowMs: 60 \* 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'AI rate limit. Please wait a moment.', code: 'AI\_RATE\_LIMIT' },
});

app.use('/api/', generalLimiter);
app.get('/health', (req, res) =&gt; {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE\_ENV || 'development',
    uptime: process.uptime(),
    allowedFrontends: FRONTEND\_URLS,
    connections: io.engine?.clientsCount ?? 0,
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
app.use('/api/notifications', authenticateToken, notificationRoutes);

const translationProviderKeys = {
  groq: 'GROQ\_API\_KEY',
  gemini: 'GEMINI\_API\_KEY',
  openai: 'OPENAI\_API\_KEY',
  xai: 'XAI\_API\_KEY',
};
app.post('/api/one-to-one/messages/:messageId/translate', authenticateToken, (req, res, next) =&gt; {
  const provider = String(process.env.AI\_PROVIDER || '').trim().toLowerCase();
  const providerKey = translationProviderKeys\[provider\];
  const configuredProviderKeys = Object.values(translationProviderKeys)
    .filter((key) =&gt; Boolean(process.env\[key\]));
  const explicitlyEnabled = String(process.env.ONE\_TO\_ONE\_TRANSLATION\_ENABLED || '').toLowerCase() === 'true';
  if (!explicitlyEnabled || !providerKey || !process.env\[providerKey\] || configuredProviderKeys.length !== 1) {
    return res.status(503).json({
      error: 'Translation is disabled until one AI provider is explicitly selected and configured.',
      code: 'TRANSLATION\_DISABLED',
    });
  }
  return next();
});
app.use('/api/one-to-one', oneToOneRoutes);

io.use(async (socket, next) =&gt; {
  try {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.query?.token ||
      (socket.handshake.headers?.authorization || '').replace(/^Bearer\\s+/i, '');
    if (!token) return next(new Error('Authentication error'));
    const decoded = jwt.verify(token, process.env.JWT\_SECRET);
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
initOneToOneCallHandler(io, prisma);
const oneToOneMaintenanceTimer = startOneToOneMaintenance(io);
const oneToOneDataSafetyTimer = startOneToOneDataSafety(prisma);

io.on('connection', (socket) =&gt; {
  if (socket.userId) socket.join(`user:${socket.userId}`);
});

app.use((req, res) =&gt; {
  res.status(404).json({ error: 'Route not found', path: req.path, method: req.method });
});
app.use(errorHandler);

const PORT = parseInt(process.env.PORT || '3000', 10);
httpServer.listen(PORT, '0.0.0.0', () =&gt; {
  console.log(`Connect backend on 0.0.0.0:${PORT}`);
});

async function shutdown(signal) {
  clearInterval(oneToOneMaintenanceTimer);
  clearInterval(oneToOneDataSafetyTimer);
  httpServer.close(async () =&gt; {
    try { await prisma.$disconnect(); } catch (\_) {}
    process.exit(0);
  });
  setTimeout(() =&gt; process.exit(1), 10000).unref?.();
}
process.on('SIGINT', () =&gt; shutdown('SIGINT'));
process.on('SIGTERM', () =&gt; shutdown('SIGTERM'));

export { app, httpServer, io, prisma };