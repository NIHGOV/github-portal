//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { describe, expect, it, vi } from 'vitest';

import { requireAnyAuthorizedEntraApiScope, requireAuthorizedEntraApiScope } from './index.js';

import type { NextFunction, Response } from 'express';
import type { ApiRequestToken, ReposApiRequest } from '../../../interfaces/index.js';

function createResponse(): Response {
  return {
    header: vi.fn(),
  } as unknown as Response;
}

function createRequest(apiKeyToken?: Partial<ApiRequestToken>): ReposApiRequest {
  return {
    apiKeyToken: apiKeyToken as ApiRequestToken,
  } as ReposApiRequest;
}

describe('Entra API scope middleware', () => {
  it('accepts any authorized scope when hasAnyScope returns true without an explicit scope list', () => {
    const hasAnyScope = vi.fn().mockReturnValue(true);
    const req = createRequest({
      hasAnyScope,
    });
    const res = createResponse();
    const next = vi.fn() as NextFunction;

    requireAnyAuthorizedEntraApiScope(req, res, next);

    expect(hasAnyScope).toHaveBeenCalledWith();
    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
  });

  it('passes requested scopes into hasAnyScope for explicit scope checks', () => {
    const hasAnyScope = vi.fn().mockReturnValue(true);
    const req = createRequest({
      hasAnyScope,
    });
    const res = createResponse();
    const next = vi.fn() as NextFunction;

    requireAuthorizedEntraApiScope(['repo/create', 'repo/delete'])(req, res, next);

    expect(hasAnyScope).toHaveBeenCalledWith(['repo/create', 'repo/delete']);
    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
  });

  it('rejects requests when no authorized scopes are known', () => {
    const hasAnyScope = vi.fn().mockReturnValue(false);
    const req = createRequest({
      hasAnyScope,
    });
    const res = createResponse();
    const next = vi.fn() as NextFunction;

    requireAnyAuthorizedEntraApiScope(req, res, next);

    expect(hasAnyScope).toHaveBeenCalledWith();
    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Not authorized for any scopes',
      })
    );
  });
});
