//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { NextFunction, Response, Router } from 'express';

import { ReposAppRequest } from '../../../interfaces/index.js';
import { CreateError, getProviders } from '../../../lib/transitional.js';
import { stringParam } from '../../../lib/utils.js';
import { ALLOWED_SESSION_FLAGS, validateSessionFlag } from '../../../business/features/sessionFlags.js';

import type { IndividualContext } from '../../../business/user/index.js';

const router: Router = Router();

function requireSessionFlagsEnabled(req: ReposAppRequest, res: Response, next: NextFunction) {
  const { config } = getProviders(req);
  if (!config?.features?.allowSessionFeatureFlags) {
    return next(CreateError.NotFound('Session feature flags are not enabled in this environment'));
  }
  return next();
}

router.use(requireSessionFlagsEnabled);

router.post('/:flag', (req: ReposAppRequest, res: Response, next: NextFunction) => {
  const activeContext = (req.individualContext || req.apiContext) as IndividualContext;
  const webContext = activeContext?.webContext;
  if (!webContext) {
    return next(CreateError.InvalidParameters('Session feature flags require a web session context'));
  }
  const flag = validateSessionFlag(stringParam(req, 'flag'));
  if (!flag) {
    return next(
      CreateError.InvalidParameters(
        `Invalid or unsupported flag. Allowed flags: ${[...ALLOWED_SESSION_FLAGS].join(', ')}`
      )
    );
  }
  const added = webContext.addSessionFlag(flag);
  return res.json({ flag, added, sessionFlags: webContext.getSessionFlags() }) as unknown as void;
});

router.delete('/:flag', (req: ReposAppRequest, res: Response, next: NextFunction) => {
  const activeContext = (req.individualContext || req.apiContext) as IndividualContext;
  const webContext = activeContext?.webContext;
  if (!webContext) {
    return next(CreateError.InvalidParameters('Session feature flags require a web session context'));
  }
  const flag = validateSessionFlag(stringParam(req, 'flag'));
  if (!flag) {
    return next(
      CreateError.InvalidParameters(
        `Invalid or unsupported flag. Allowed flags: ${[...ALLOWED_SESSION_FLAGS].join(', ')}`
      )
    );
  }
  const removed = webContext.removeSessionFlag(flag);
  return res.json({ flag, removed, sessionFlags: webContext.getSessionFlags() }) as unknown as void;
});

router.get('/', (req: ReposAppRequest, res: Response, next: NextFunction) => {
  const activeContext = (req.individualContext || req.apiContext) as IndividualContext;
  const webContext = activeContext?.webContext;
  if (!webContext) {
    return next(CreateError.InvalidParameters('Session feature flags require a web session context'));
  }
  return res.json({ sessionFlags: webContext.getSessionFlags() }) as unknown as void;
});

export default router;
