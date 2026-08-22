//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { describe, expect, it, vi } from 'vitest';

import SiteErrorHandler from './errorHandler.js';

import type { NextFunction, Response } from 'express';
import type { ReposAppRequest } from '../interfaces/index.js';

function createMockRequest(overrides: Record<string, unknown> = {}): Partial<ReposAppRequest> {
  return {
    url: '/',
    originalUrl: '/',
    scrubbedUrl: '/',
    headers: {},
    user: undefined,
    app: {
      settings: {
        providers: {
          applicationProfile: {
            customErrorHandlerRender: null,
          },
          config: {
            logging: { errors: false },
            authentication: { scheme: 'github' },
          },
        },
      },
    } as any,
    insights: undefined,
    correlationId: 'test-correlation-id',
    ...overrides,
  };
}

function createMockResponse() {
  const res: Partial<Response> = {
    headersSent: false,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    render: vi.fn().mockReturnThis(),
  };
  return res;
}

describe('SiteErrorHandler', () => {
  it('responds with JSON when the URL starts with /api/', () => {
    const req = createMockRequest({
      url: '/api/people',
      originalUrl: '/api/people',
      scrubbedUrl: '/api/people',
    });
    const res = createMockResponse();
    const next = vi.fn();
    const error = new Error('not found');
    (error as any).status = 404;
    (error as any).skipLog = true;

    SiteErrorHandler(error, req as ReposAppRequest, res as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'not found', correlationId: 'test-correlation-id' })
    );
    expect(res.render).not.toHaveBeenCalled();
  });

  it('responds with JSON when req.apiContext is set', () => {
    const req = createMockRequest({
      url: '/organization/my-org/members',
      originalUrl: '/organization/my-org/members',
      scrubbedUrl: '/organization/my-org/members',
      apiContext: {} as any,
    });
    const res = createMockResponse();
    const next = vi.fn();
    const error = new Error('forbidden');
    (error as any).status = 403;
    (error as any).skipLog = true;

    SiteErrorHandler(error, req as ReposAppRequest, res as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'forbidden', correlationId: 'test-correlation-id' })
    );
    expect(res.render).not.toHaveBeenCalled();
  });

  it('responds with JSON when Accept header requests application/json', () => {
    const req = createMockRequest({
      url: '/repos',
      originalUrl: '/repos',
      scrubbedUrl: '/repos',
      headers: { accept: 'application/json' },
    });
    const res = createMockResponse();
    const next = vi.fn();
    const error = new Error('bad request');
    (error as any).status = 400;
    (error as any).skipLog = true;

    SiteErrorHandler(error, req as ReposAppRequest, res as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'bad request', correlationId: 'test-correlation-id' })
    );
    expect(res.render).not.toHaveBeenCalled();
  });

  it('renders an HTML view for non-API routes without apiContext', () => {
    const req = createMockRequest({
      url: '/repos',
      originalUrl: '/repos',
      scrubbedUrl: '/repos',
    });
    const res = createMockResponse();
    const next = vi.fn();
    const error = new Error('something broke');
    (error as any).status = 500;
    (error as any).skipLog = true;

    SiteErrorHandler(error, req as ReposAppRequest, res as Response, next as NextFunction);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.render).toHaveBeenCalledWith('error', expect.objectContaining({ message: 'something broke' }));
    expect(res.json).not.toHaveBeenCalled();
  });
});
