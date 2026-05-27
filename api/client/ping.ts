//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { NextFunction, Response, Router } from 'express';

import { CreateError } from '../../lib/transitional.js';

import type { ReposAppRequest } from '../../interfaces/index.js';

const router: Router = Router();

router.get('/', (req: ReposAppRequest, res: Response) => {
  return res.json({ pong: true, method: 'GET' }) as unknown as void;
});

router.post('/', (req: ReposAppRequest, res: Response) => {
  return res.json({ pong: true, method: 'POST', csrfValidated: true }) as unknown as void;
});

router.use('/*splat', (req: ReposAppRequest, res: Response, next: NextFunction) => {
  return next(CreateError.NotFound('API or route not found'));
});

export default router;
