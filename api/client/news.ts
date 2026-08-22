//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { NextFunction, Response, Router } from 'express';

import { CreateError, getProviders } from '../../lib/transitional.js';
import { ReposAppRequest } from '../../interfaces/index.js';

const router: Router = Router();

router.get('/', async (req: ReposAppRequest, res) => {
  const { config } = getProviders(req);
  return res.json({ articles: config?.news?.all || [] }) as unknown as void;
});

router.use('/*splat', (req: ReposAppRequest, res: Response, next: NextFunction) => {
  return next(CreateError.NotFound('API or route not found within news'));
});

export default router;
