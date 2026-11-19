import type { FastifyInstance } from 'fastify';
import { identityRoutes } from '../modules/identity/routes.js';
import { profileRoutes } from '../modules/profile/routes.js';
import { facilityRoutes } from '../modules/facilities/routes.js';
import { documentRoutes } from '../modules/documents/routes.js';
import { workflowRoutes } from '../modules/workflow/routes.js';
import { threadRoutes } from '../modules/threads/routes.js';
import { financialRoutes } from '../modules/analysis/financial-routes.js';
import { statementRoutes } from '../modules/analysis/statement-routes.js';
import { creditRoutes } from '../modules/analysis/credit-routes.js';
import { docgenRoutes } from '../modules/docgen/routes.js';
import { offerRoutes } from '../modules/offers/routes.js';
import { servicingRoutes } from '../modules/servicing/routes.js';
import { adminRoutes } from '../modules/admin/routes.js';
import { userImportRoutes } from '../modules/admin/user-import-routes.js';
import { portalUserRoutes } from '../modules/profile/portal-users.js';
import { notificationRoutes } from '../modules/notifications/routes.js';
import { reportRoutes } from '../modules/reports/routes.js';
import { aiRoutes } from '../modules/ai/routes.js';

export async function registerRoutes(app: FastifyInstance) {
  for (const r of [identityRoutes, profileRoutes, facilityRoutes, documentRoutes, workflowRoutes, threadRoutes, financialRoutes, statementRoutes, creditRoutes, docgenRoutes, offerRoutes, servicingRoutes, adminRoutes, userImportRoutes, portalUserRoutes, notificationRoutes, reportRoutes, aiRoutes]) await app.register(r);
}
