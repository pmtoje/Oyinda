import type { FastifyInstance } from 'fastify';
import { identityRoutes } from '../modules/identity/routes.js';

export async function registerRoutes(app: FastifyInstance) {
  await app.register(identityRoutes);
}
