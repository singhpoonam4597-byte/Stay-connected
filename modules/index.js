/**
 * Connect backend — modular monolith map
 * Route URLs unchanged. Domain entrypoints for gradual migration.
 */
export { authRoutes, authenticateToken } from './auth/index.js';
export { userRoutes } from './users/index.js';
export { messageRoutes, conversationRoutes } from './messages/index.js';
export { groupRoutes } from './groups/index.js';
export { aiRoutes } from './ai/index.js';
export { settingsRoutes } from './settings/index.js';
export { uploadRoutes } from './upload/index.js';
export { initChatHandler, initPresenceHandler } from './realtime/index.js';
export { errorHandler, rateLimit } from './shared/index.js';
export { notificationRoutes } from './notifications/index.js';
export { prisma } from './database/index.js';
