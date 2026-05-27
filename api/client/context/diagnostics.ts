//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { Router } from 'express';

import { IAppSession, ReposAppRequest } from '../../../interfaces/index.js';
import { IndividualContext } from '../../../business/user/index.js';
import { CreateError } from '../../../lib/transitional.js';
import { collectSessionDiagnostics } from '../../../lib/diagnostics.js';

const router: Router = Router();

router.get('/', (req: ReposAppRequest, res, next) => {
  if (!req.isAuthenticated || !req.isAuthenticated() || !req.session) {
    return next(CreateError.CreateStatusCodeError(403, 'Diagnostics require an authenticated web session'));
  }
  const activeContext = (req.individualContext || req.apiContext) as IndividualContext;
  const { insights } = activeContext;
  insights?.trackMetric({ name: 'SessionDiagnosticsViewed', value: 1 });
  const session = req.session as IAppSession;
  const diagnostics = collectSessionDiagnostics(session, (req as any).user);
  return res.json(diagnostics) as unknown as void;
});

export default router;
