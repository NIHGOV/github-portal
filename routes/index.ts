//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { Router } from 'express';
const router: Router = Router();

import bodyParser from 'body-parser';

import { webContextMiddleware } from '../middleware/business/setContext.js';
import { sessionCsrfProtection } from '../middleware/business/csrf.js';

import routeDiagnostics from './diagnostics.js';
import routeAuthenticatedRoutes from './index-authenticated.js';
import routeClientApi from '../api/client/index.js';
import { FrontendMode, getFrontendMode } from '../lib/transitional.js';
import getCompanySpecificDeployment from '../middleware/companySpecificDeployment.js';

const frontendMode = getFrontendMode();
const dynamicStartupInstance = getCompanySpecificDeployment();

router.use('/api/client', /* API routes provide their own parser */ bodyParser.json(), routeClientApi);

router.use(webContextMiddleware);
router.use(sessionCsrfProtection);

if (dynamicStartupInstance?.routes?.connectRootRoutes) {
  dynamicStartupInstance.routes.connectRootRoutes(router);
}

if (frontendMode === FrontendMode.Skip) {
  router.use('/session', routeDiagnostics);
}

router.use(routeAuthenticatedRoutes);

export default router;
