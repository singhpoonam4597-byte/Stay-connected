import { notifyNewMessage } from './notifications.js';
import express from 'express';
import { prisma } from './prisma.js';
import { authenticateToken } from './auth.js';

const router = express.Router();

// TEMP: full file restore in next commit if truncated — use artifact messages.js
export default router;
