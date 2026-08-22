//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { NextFunction, Response, Router } from 'express';

import { Team } from '../../../../business/index.js';
import { CreateError } from '../../../../lib/transitional.js';
import { setContextualTeam } from '../../../../middleware/github/teamPermissions.js';
import { ReposAppRequest } from '../../../../interfaces/index.js';
import { scrubErrorForLogging, stringParam } from '../../../../lib/utils.js';

import RouteTeam from './team.js';

const router: Router = Router();

// CONSIDER: list their teams router.get('/ ')

router.use('/:teamSlug', async (req: ReposAppRequest, res: Response, next: NextFunction) => {
  const { organization } = req;
  const teamSlug = stringParam(req, 'teamSlug');
  let team: Team = null;
  try {
    team = await organization.getTeamFromSlug(teamSlug);
    setContextualTeam(req, team);
  } catch (error) {
    scrubErrorForLogging(error);
    console.dir(error);
    return next(error);
  }
  return next();
});

router.use('/:teamSlug', RouteTeam);

router.use('/*splat', (req, res: Response, next: NextFunction) => {
  return next(CreateError.NotFound('no API or function available for repos'));
});

export default router;
