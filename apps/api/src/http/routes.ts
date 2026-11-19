import type { FastifyInstance } from 'fastify';
import { identityRoutes } from '../modules/identity/routes.js';
import { profileRoutes } from '../modules/profile/routes.js';
import { facilityRoutes } from '../modules/facilities/routes.js';
import { documentRoutes } from '../modules/documents/routes.js';
import { workflowRoutes } from '../modules/workflow/routes.js';
import { threadRoutes } from '../modules/threads/routes.js';

export async function registerRoutes(app: FastifyInstance) {
  for (const r of [identityRoutes, profileRoutes, facilityRoutes, documentRoutes, workflowRoutes, threadRoutes]) await app.register(r);
}
