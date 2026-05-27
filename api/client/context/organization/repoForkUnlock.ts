//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { NextFunction, Response, Router } from 'express';

import { getRepositoryMetadataProvider, ReposAppRequest } from '../../../../interfaces/index.js';
import { Organization } from '../../../../business/index.js';
import { getContextualRepository } from '../../../../middleware/github/repoPermissions.js';
import { IndividualContext } from '../../../../business/user/index.js';
import { CreateError, ErrorHelper, getProviders } from '../../../../lib/transitional.js';
import NewRepositoryLockdownSystem from '../../../../business/features/newRepositories/newRepositoryLockdown.js';

const router: Router = Router();

router.use(async (req: ReposAppRequest, res: Response, next: NextFunction) => {
  const organization = req.organization as Organization;
  if (!organization.isNewRepositoryLockdownSystemEnabled()) {
    return next(
      CreateError.InvalidParameters('This endpoint is not available as configured for the organization')
    );
  }
  const activeContext = (req.individualContext || req.apiContext) as IndividualContext;
  const isOrgSudoer = await organization.isSudoer(
    activeContext.getGitHubIdentity().username,
    activeContext.link
  );
  if (!isOrgSudoer) {
    const isPortalSudoer = await activeContext.isPortalAdministrator();
    if (!isPortalSudoer) {
      return next(CreateError.NotAuthorized('You do not have sudo permission for this organization'));
    }
  }
  return next();
});

router.post('/approve', async (req: ReposAppRequest, res: Response, next: NextFunction) => {
  const { insights } = req;
  const { operations } = getProviders(req);
  const repository = getContextualRepository(req);
  const repositoryMetadataProvider = getRepositoryMetadataProvider(operations);
  const organization = repository.organization;
  const lockdownSystem = new NewRepositoryLockdownSystem({
    insights,
    operations,
    organization,
    repository,
    repositoryMetadataProvider,
  });
  try {
    await lockdownSystem.removeAdministrativeLock();
    return res.json({
      message: `Unlocked the ${repository.name} repo in the ${organization.name} org`,
      unlocked: true,
    }) as unknown as void;
  } catch (error) {
    return next(
      CreateError.CreateStatusCodeError(
        ErrorHelper.GetStatus(error) || 500,
        `Problem while approving the administrative lock: ${error}`
      )
    );
  }
});

router.use('/*splat', (req, res: Response, next: NextFunction) => {
  return next(CreateError.NotFound(`no API or ${req.method} function available for repo fork unlock`));
});

export default router;
