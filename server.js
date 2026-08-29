import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';
import { PrismaClient } from '@prisma/client';

// Import route handlers
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import messageRoutes from './routes/messages.js';
import conversationRoutes from './routes/conversations.js';
import groupRoutes from './routes/groups.js';
import uploadRoutes from './routes/upload.js';
import settingsRoutes from './routes/settings.js';

// Import middleware
import { authenticateToken } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';

// Import socket handlers
import { initChatHandler } from './sockets/chatHandler.js';
import { initPresenceHandler } from './sockets/presenceHandler.js';

dotenv.config();

// Initialize Express and HTTP server
const app = express();
const httpServer = createServer(app);

// Initialize Socket.io
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  },
  path: process.env.SOCKET_PATH || '/socket.io',
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 60000
});

// Initialize Prisma client
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error']
});

// ============================================================================
// MIDDLEWARE SETUP
// ============================================================================

// Security middleware
app.use(helmet());

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// CORS middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200
}));

// Request logging middleware (development only)
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
  });
}

// ============================================================================
// RATE LIMITING
// ============================================================================

const generalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'),
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many authentication attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => process.env.NODE_ENV === 'development'
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 50,
  message: 'Too many file uploads, please try again later.',
});

// Apply rate limiters
app.use('/api/', generalLimiter);

// ============================================================================
// ROUTES
// ============================================================================

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    uptime: process.uptime()
  });
});

// Authentication routes (with auth limiter)
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);
app.use('/api/auth', authRoutes);

// Protected routes (require authentication)
app.use('/api/users', authenticateToken, userRoutes);
app.use('/api/messages', authenticateToken, messageRoutes);
app.use('/api/conversations', authenticateToken, conversationRoutes);
app.use('/api/groups', authenticateToken, groupRoutes);
app.use('/api/upload', authenticateToken, uploadLimiter, uploadRoutes);
app.use('/api/settings', authenticateToken, settingsRoutes);

// ============================================================================
// SOCKET.IO SETUP
// ============================================================================

// Middleware to authenticate socket connections
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication error'));
    }

    const decoded = await verifySocketToken(token);
    if (!decoded) {
      return next(new Error('Invalid token'));
    }

    socket.userId = decoded.id;
    socket.userEmail = decoded.email;
    socket.username = decoded.username;
    next();
  } catch (error) {
    next(new Error('Authentication error'));
  }
});

// Initialize socket event handlers
initChatHandler(io, prisma);
initPresenceHandler(io, prisma);

// Socket connection logging
io.on('connection', (socket) => {
  console.log(`✅ User connected: ${socket.userId} (Socket: ${socket.id})`);
  
  socket.on('disconnect', () => {
    console.log(`❌ User disconnected: ${socket.userId} (Socket: ${socket.id})`);
  });
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.path,
    method: req.method
  });
});

// Global error handler (must be last)
app.use(errorHandler);

// ============================================================================
// SERVER STARTUP
// ============================================================================

const PORT = parseInt(process.env.PORT || '3000');
const HOST = '0.0.0.0';

httpServer.listen(PORT, HOST, () => {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 CHAT APP SERVER STARTED');
  console.log('='.repeat(60));
  console.log(`📡 Server running on ${HOST}:${PORT}`);
  console.log(`🌍 Frontend URL: ${process.env.FRONTEND_URL}`);
  console.log(`🗄️  Database: ${process.env.DATABASE_URL?.substring(0, 30)}...`);
  console.log(`📝 Environment: ${process.env.NODE_ENV}`);
  console.log('='.repeat(60) + '\n');
});

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  
  httpServer.close(async () => {
    console.log('🔌 HTTP server closed');
    await prisma.$disconnect();
    console.log('💾 Prisma disconnected');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('❌ Forced shutdown after 10s');
    process.exit(1);
  }, 10000);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 SIGTERM received, shutting down...');
  
  httpServer.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function verifySocketToken(token) {
  try {
    const jwt = await import('jsonwebtoken');
    return jwt.default.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return null;
  }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

export { app, httpServer, io };
