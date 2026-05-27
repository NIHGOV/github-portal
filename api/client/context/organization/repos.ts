//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { NextFunction, Response, Router } from 'express';

import { Repository } from '../../../../business/index.js';
import { CreateError } from '../../../../lib/transitional.js';
import { setContextualRepository } from '../../../../middleware/github/repoPermissions.js';
import { stringParam } from '../../../../lib/utils.js';

import {
  OrganizationMembershipState,
  ReposAppRequest,
  VoidedExpressRoute,
} from '../../../../interfaces/index.js';
import { IndividualContext } from '../../../../business/user/index.js';
import { createRepositoryFromClient, setRepositoryCreateSourceThenNext } from '../../newOrgRepo.js';

import routeContextualRepo from './repo.js';

const router: Router = Router();

async function validateActiveMembership(req: ReposAppRequest, res: Response, next: NextFunction) {
  const { organization } = req;
  const activeContext = (req.individualContext || req.apiContext) as IndividualContext;
  if (!activeContext.link) {
    return next(
      CreateError.InvalidParameters(
        'You must be linked and a member of the organization to create and manage repos'
      )
    );
  }
  const membership = await organization.getOperationalMembership(activeContext.getGitHubIdentity().username);
  if (!membership || membership.state !== OrganizationMembershipState.Active) {
    return next(
      CreateError.InvalidParameters('You must be a member of the organization to create and manage repos')
    );
  }
  req['knownRequesterMailAddress'] = activeContext.link.corporateMailAddress;
  return next();
}

router.post(
  '/',
  validateActiveMembership,
  setRepositoryCreateSourceThenNext.bind('client'),
  createRepositoryFromClient as VoidedExpressRoute
);

router.use('/:repoName', async (req: ReposAppRequest, res: Response, next: NextFunction) => {
  const { organization } = req;
  const repoName = stringParam(req, 'repoName');
  let repository: Repository = null;
  repository = organization.repository(repoName);
  setContextualRepository(req, repository);
  return next();
});

router.use('/:repoName', routeContextualRepo);

router.use('/*splat', (req, res: Response, next: NextFunction) => {
  return next(CreateError.NotFound('no API or function available for repos'));
});

export default router;
