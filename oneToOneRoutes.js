import express from 'express';
import { authenticateToken } from './auth.js';
import { registerPart1 } from './oneToOneRoutes.part1.js';
import { registerPart2 } from './oneToOneRoutes.part2.js';

const router = express.Router();
router.use(authenticateToken);
registerPart1(router);
registerPart2(router);
export default router;
