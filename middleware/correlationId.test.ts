//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { describe, expect, it, vi } from 'vitest';

import correlationId from './correlationId.js';

import type { WithCorrelationId } from './correlationId.js';
import type { NextFunction, Request, Response } from 'express';

describe('correlationId middleware', () => {
  it('sets request correlation ID and response header', () => {
    const req: WithCorrelationId<Partial<Request>> = {
      header: vi.fn().mockReturnValue(undefined),
    };
    const res = {
      setHeader: vi.fn(),
    };
    const next = vi.fn();

    correlationId(
      req as WithCorrelationId<Request>,
      res as unknown as Response,
      next as unknown as NextFunction
    );

    expect(req.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(res.setHeader).toHaveBeenCalledWith('x-correlation-id', req.correlationId);
    expect(next).toHaveBeenCalledOnce();
  });

  it('uses inbound x-correlation-id header when provided', () => {
    const inboundCorrelationId = '9b7f2fd8-6f4b-4d5c-a5c0-2f5de4f228aa';
    const req: WithCorrelationId<Partial<Request>> = {
      header: vi.fn().mockReturnValue(` ${inboundCorrelationId} `),
    };
    const res = {
      setHeader: vi.fn(),
    };
    const next = vi.fn();

    correlationId(
      req as WithCorrelationId<Request>,
      res as unknown as Response,
      next as unknown as NextFunction
    );

    expect(req.correlationId).toBe(inboundCorrelationId);
    expect(res.setHeader).toHaveBeenCalledWith('x-correlation-id', inboundCorrelationId);
    expect(next).toHaveBeenCalledOnce();
  });
});
