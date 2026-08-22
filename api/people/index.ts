//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { NextFunction, Response, Router } from 'express';

import { CreateError } from '../../lib/transitional.js';

import type { ReposAppRequest } from '../../interfaces/index.js';

const router: Router = Router();

import LinksRoute from './links.js';
import UnlinkRoute from './unlink.js';

router.use('/links', LinksRoute);
router.use('/unlink', UnlinkRoute);

router.use((req: ReposAppRequest, res: Response, next: NextFunction) => {
  return next(CreateError.NotFound('Endpoint not found'));
});

export default router;
