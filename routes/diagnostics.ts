//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { Router } from 'express';
const router: Router = Router();

import { getProviders } from '../lib/transitional.js';
import { collectSessionDiagnostics } from '../lib/diagnostics.js';

import type { IAppSession, ReposAppRequest } from '../interfaces/index.js';

function renderDiagnosticsPage(req: ReposAppRequest, res, pingResult?: Record<string, unknown>) {
  const { config } = getProviders(req);
  const session = req.session as IAppSession;
  const diagnostics = collectSessionDiagnostics(session, (req as any).user);
  // preserve legacy myinfo fields that are not part of the shared diagnostics
  const safeUserView = {
    cookies: (req as any).cookies,
    ...diagnostics,
    websiteHostname: process.env.WEBSITE_HOSTNAME,
  };
  return res.render('message', {
    message: 'My information',
    messageTiny: pingResult
      ? 'This information may be useful for diagnosing issues. The test ping completed successfully.'
      : 'This information might be useful in helping diagnose issues.',
    messageOutput: JSON.stringify(safeUserView, undefined, 2),
    messageDetails: pingResult ? `Test ping response: ${JSON.stringify(pingResult)}` : undefined,
    postAction: `${req.baseUrl}/ping`,
    postButtonText: 'Test ping',
    user: (req as any).user,
    config: config,
    corporateLinks: config.corporate.trainingResources['public-homepage'],
    serviceBanner: config && config.serviceMessage ? config.serviceMessage.banner : undefined,
    title: 'Open Source Portal for GitHub - ' + config.brand.companyName,
  });
}

router.get('/', (req: ReposAppRequest, res) => {
  return renderDiagnosticsPage(req, res);
});

router.post('/ping', (req: ReposAppRequest, res) => {
  return renderDiagnosticsPage(req, res, {
    pong: true,
    method: 'POST',
    csrfValidated: true,
  });
});

export default router;
