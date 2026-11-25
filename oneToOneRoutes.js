import express from 'express';
import { authenticateToken } from './auth.js';
import { registerChunk0 } from './oneToOneRoutes.chunk0.js';
import { registerChunk1 } from './oneToOneRoutes.chunk1.js';
import { registerChunk2 } from './oneToOneRoutes.chunk2.js';
import { registerChunk3 } from './oneToOneRoutes.chunk3.js';
import { registerChunk4 } from './oneToOneRoutes.chunk4.js';

const router = express.Router();
router.use(authenticateToken);
registerChunk0(router);
registerChunk1(router);
registerChunk2(router);
registerChunk3(router);
registerChunk4(router);
export default router;
