import { prisma } from '../database/index.js';
import { createSpacesRouter } from '../../spaces.js';

export const spacesRoutes = createSpacesRouter(prisma);
