import type { Router } from '../../server/router.js';
import { registerCursorCloudRoutes } from './routes.js';

export function registerBackgroundAgentCursor(router: Router) {
  registerCursorCloudRoutes(router);
}


