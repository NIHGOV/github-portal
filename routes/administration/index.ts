//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import express from 'express';
import asyncHandler from 'express-async-handler';
import getCompanySpecificDeployment from '../../middleware/companySpecificDeployment';
const router = express.Router();

import { ReposAppRequest, IProviders } from '../../transitional';

import RouteApp from './app';
import RouteApps from './apps';

router.use('*', asyncHandler(async function (req: ReposAppRequest, res, next) {
  const { corporateAdministrationProfile } = req.app.settings.providers as IProviders;
  if (corporateAdministrationProfile && corporateAdministrationProfile.urls) {
    req.individualContext.setInitialViewProperty('_corpAdminUrls', corporateAdministrationProfile.urls);
  }
  return next();
}));

try {
  const dynamicStartupInstance = getCompanySpecificDeployment();
  const profile = dynamicStartupInstance?.administrationSection;
  if (profile && profile.setupRoutes) {
    profile.setupRoutes(router);
  }
} catch (error) {
  console.dir(error);
}
router.use('/app', RouteApp);
router.use('/apps', RouteApps);

router.get('/', (req: ReposAppRequest, res, next) => {
  const individualContext = req.individualContext;
  individualContext.webContext.render({
    view: 'administration',
    title: 'Administration',
    state: {
      // nothing
    },
  });
});

export default router;
