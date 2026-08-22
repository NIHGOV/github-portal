//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { NextFunction, Response, Router } from 'express';

import { sendLinkedAccountMail } from '../../../business/operations/link.js';
import { ReposAppRequest } from '../../../interfaces/index.js';
import { CreateError, getProviders } from '../../../lib/transitional.js';
import { IndividualContext } from '../../../business/user/index.js';
import { stringParam } from '../../../lib/utils.js';

const router: Router = Router();

router.get('/:templateName', async (req: ReposAppRequest, res: Response, next: NextFunction) => {
  const { operations } = getProviders(req);
  const activeContext = (req.individualContext || req.apiContext) as IndividualContext;
  const templateName = stringParam(req, 'templateName');
  try {
    switch (templateName) {
      case 'link': {
        await sendLinkedAccountMail(
          operations,
          activeContext.link,
          activeContext.link.corporateMailAddress || activeContext.corporateIdentity?.username,
          'sample',
          true
        );
        break;
      }
      default: {
        throw CreateError.InvalidParameters(`The template name ${templateName} is not supported`);
      }
    }
  } catch (error) {
    return next(error);
  }
  return res.json({ templateName }) as unknown as void;
});

router.use('/*splat', (req: ReposAppRequest, res: Response, next: NextFunction) => {
  return next(CreateError.NotFound('Contextual API or route not found within samples'));
});

export default router;
