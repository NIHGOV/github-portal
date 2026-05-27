//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { NextFunction, Response, Router } from 'express';

import { CreateError } from '../../lib/transitional.js';
import { clearSessionCsrfToken } from '../../middleware/business/csrf.js';
import { IAppSession, ReposAppRequest } from '../../interfaces/index.js';

const router: Router = Router();

// This route is /api/client/signout*

router.post('/', (req: ReposAppRequest, res) => {
  const { insights } = req;
  // For client apps, we keep the session active to allow
  // for a few feature flags to be present.
  req.logout({ keepSessionInfo: true }, (err) => {
    const session = req.session as IAppSession;
    if (session) {
      clearSessionCsrfToken(session);
      delete session.enableMultipleAccounts;
      delete session.selectedGithubId;
      delete session.sessionFlags;
    }
    if (err) {
      insights?.trackException({ exception: err });
      res.status(500);
    } else {
      res.status(204);
    }
    res.end();
  });
});

router.post('/github', (req: ReposAppRequest, res) => {
  const session = req.session as IAppSession;
  clearSessionCsrfToken(session);
  if (session?.passport?.user?.github) {
    delete session.passport.user.github;
  }
  res.status(204);
  res.end();
});

router.use('/*splat', (req: ReposAppRequest, res: Response, next: NextFunction) => {
  return next(CreateError.NotFound('API or route not found'));
});

export default router;
