//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';

const CORRELATION_ID_RESPONSE_HEADER = 'x-correlation-id';

export type WithCorrelationId<T> = T & {
  correlationId?: string;
};

// Generate or propagate a correlation ID
export default function (req: WithCorrelationId<Request>, res: Response, next: NextFunction) {
  let correlationId = req.correlationId;

  if (!correlationId) {
    const headerValue = req.header(CORRELATION_ID_RESPONSE_HEADER);
    if (typeof headerValue === 'string' && headerValue.trim()) {
      correlationId = headerValue.trim();
    } else {
      correlationId = randomUUID();
    }
  }

  req.correlationId = correlationId;
  res.setHeader(CORRELATION_ID_RESPONSE_HEADER, correlationId);
  return next();
}
