//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { NextFunction, Response } from 'express';

import type { ReposAppRequest } from '../interfaces/web.js';

export default function jsonErrorHandler(
  err: Error,
  _req: ReposAppRequest,
  _res: Response,
  next: NextFunction
) {
  // All errors bubble through to the site error handler which
  // knows how to render JSON for /api/ routes.
  return next(err);
}
