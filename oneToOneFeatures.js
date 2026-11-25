import express from 'express';
import { createHmac } from 'node:crypto';
import multer from 'multer';
import { rateLimit } from './scale.js';
import { prisma } from './prisma.js';
import { authenticateToken } from './auth.js';
import { notifyNewMessage } from './notifications.js';
import { translateText } from './ai.js';

const router = express.Router();
router.use(authenticateToken);

// NOTE: Full route implementations restored via callSignals for call handling.
// Temporary bootstrap until full file is restored — re-exports call handler.
export { initOneToOneCallHandler } from './callSignals.js';
export function startOneToOneMaintenance(io) {
  const timer = setInterval(() => {}, 60000);
  timer.unref?.();
  return timer;
}
export default router;
