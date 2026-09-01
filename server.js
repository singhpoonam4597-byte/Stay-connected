import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

import authRoutes from './auth.js';

dotenv.config();

// Export Prisma client for use across route modules
export const prisma = new PrismaClient();

const app = express();

// Trust reverse proxy headers (required for Railway, Vercel, Heroku, etc.)
app.set('trust proxy', 1);

// Middleware configuration
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// API Routes
app.use('/api/auth', authRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date() });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ message: 'Connect Backend API Server is running' });
});

// Global error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  res.status(500).json({
    error: 'Internal server error',
    code: 'SERVER_ERROR'
  });
});

const PORT = process.env.PORT || 8080;
const httpServer = createServer(app);

// Socket.io initialization
export const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.id}`);
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('==================================================');
  console.log('🚀 CHAT APP SERVER STARTED');
  console.log('==================================================');
  console.log(`📡 Server running on 0.0.0.0:${PORT}`);
  console.log(`🌐 Frontend URL: ${process.env.FRONTEND_URL || 'https://connect-sepia-seven.vercel.app'}`);
  console.log(`🗄️ Database: ${process.env.DATABASE_URL ? 'Connected' : 'Not configured'}`);
  console.log(`⚙️ Environment: ${process.env.NODE_ENV || 'production'}`);
  console.log('==================================================');
});
