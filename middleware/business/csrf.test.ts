//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { describe, expect, it, vi } from 'vitest';

import {
  CSRF_BODY_FIELD_NAME,
  CSRF_HEADER_NAME,
  clearSessionCsrfToken,
  sessionCsrfProtection,
} from './csrf.js';

import type { NextFunction, Response } from 'express';
import type { IAppSession, ReposAppRequest } from '../../interfaces/index.js';

function createResponse() {
  return {
    getHeader: vi.fn(),
    setHeader: vi.fn(),
  } as unknown as Response;
}

function createInsights() {
  return {
    trackEvent: vi.fn(),
  };
}

describe('sessionCsrfProtection', () => {
  it('issues a CSRF token header for safe requests', () => {
    const session = {} as IAppSession;
    const req = {
      method: 'GET',
      session,
      header: vi.fn(),
    } as unknown as ReposAppRequest;
    const res = createResponse();
    (res as any).locals = {};
    const next = vi.fn() as unknown as NextFunction;

    sessionCsrfProtection(req, res, next);

    expect(session.csrfToken).toBeTruthy();
    expect(res.setHeader as any).toHaveBeenCalledWith(CSRF_HEADER_NAME, session.csrfToken);
    expect(res.setHeader as any).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(res.setHeader as any).toHaveBeenCalledWith('Pragma', 'no-cache');
    expect((res as any).locals.csrfToken).toBe(session.csrfToken);
    expect(next).toHaveBeenCalledOnce();
    expect((next as any).mock.calls[0][0]).toBeUndefined();
  });

  it('preserves existing cache-control directives while adding no-store protections', () => {
    const session = {} as IAppSession;
    const req = {
      method: 'GET',
      session,
      header: vi.fn(),
    } as unknown as ReposAppRequest;
    const res = createResponse();
    (res.getHeader as any).mockReturnValue('max-age=0');
    (res as any).locals = {};
    const next = vi.fn() as unknown as NextFunction;

    sessionCsrfProtection(req, res, next);

    expect(res.setHeader as any).toHaveBeenCalledWith('Cache-Control', 'max-age=0, private, no-store');
  });

  it('rejects state-changing requests without a CSRF token', () => {
    const session = { csrfToken: 'known-token' } as IAppSession;
    const req = {
      method: 'POST',
      protocol: 'https',
      session,
      body: {},
      header: vi.fn().mockReturnValue(undefined),
      is: vi.fn().mockReturnValue(false),
    } as unknown as ReposAppRequest;
    const res = createResponse();
    (res as any).locals = {};
    const next = vi.fn() as unknown as NextFunction;

    sessionCsrfProtection(req, res, next);

    expect((next as any).mock.calls[0][0].statusCode).toBe(403);
  });

  it('rejects state-changing requests with a mismatched CSRF token', () => {
    const session = { csrfToken: 'known-token' } as IAppSession;
    const req = {
      method: 'DELETE',
      protocol: 'https',
      session,
      body: {},
      header: vi.fn((name: string) => {
        if (name === CSRF_HEADER_NAME) {
          return 'other-token';
        }
        return undefined;
      }),
      is: vi.fn().mockReturnValue(false),
    } as unknown as ReposAppRequest;
    const res = createResponse();
    (res as any).locals = {};
    const next = vi.fn() as unknown as NextFunction;

    sessionCsrfProtection(req, res, next);

    expect((next as any).mock.calls[0][0].statusCode).toBe(403);
  });

  it('allows state-changing requests with the matching CSRF token', () => {
    const session = { csrfToken: 'known-token' } as IAppSession;
    const req = {
      method: 'PATCH',
      protocol: 'https',
      session,
      body: {},
      header: vi.fn((name: string) => {
        if (name === CSRF_HEADER_NAME) {
          return 'known-token';
        }
        return undefined;
      }),
      is: vi.fn().mockReturnValue(false),
    } as unknown as ReposAppRequest;
    const res = createResponse();
    (res as any).locals = {};
    const next = vi.fn() as unknown as NextFunction;

    sessionCsrfProtection(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect((next as any).mock.calls[0][0]).toBeUndefined();
  });

  it('allows state-changing requests with the matching form token', () => {
    const session = { csrfToken: 'known-token' } as IAppSession;
    const req = {
      method: 'POST',
      protocol: 'https',
      session,
      body: {
        [CSRF_BODY_FIELD_NAME]: 'known-token',
      },
      header: vi.fn().mockReturnValue(undefined),
      is: vi.fn((contentType: string) => contentType === 'application/x-www-form-urlencoded'),
    } as unknown as ReposAppRequest;
    const res = createResponse();
    (res as any).locals = {};
    const next = vi.fn() as unknown as NextFunction;

    sessionCsrfProtection(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect((next as any).mock.calls[0][0]).toBeUndefined();
  });

  it('rejects body tokens for non-form requests', () => {
    const session = { csrfToken: 'known-token' } as IAppSession;
    const req = {
      method: 'POST',
      protocol: 'https',
      session,
      body: {
        [CSRF_BODY_FIELD_NAME]: 'known-token',
      },
      header: vi.fn().mockReturnValue(undefined),
      is: vi.fn().mockReturnValue(false),
    } as unknown as ReposAppRequest;
    const res = createResponse();
    (res as any).locals = {};
    const next = vi.fn() as unknown as NextFunction;

    sessionCsrfProtection(req, res, next);

    expect((next as any).mock.calls[0][0].statusCode).toBe(403);
  });

  it('rejects unsafe requests with a cross-site origin even if the token matches', () => {
    const session = { csrfToken: 'known-token' } as IAppSession;
    const insights = createInsights();
    const req = {
      method: 'POST',
      protocol: 'https',
      session,
      originalUrl: '/api/client/ping',
      correlationId: 'corr-123',
      insights,
      body: {},
      header: vi.fn((name: string) => {
        if (name === CSRF_HEADER_NAME) {
          return 'known-token';
        }
        if (name === 'origin') {
          return 'https://evil.example';
        }
        if (name === 'host') {
          return 'portal.example';
        }
        return undefined;
      }),
      is: vi.fn().mockReturnValue(false),
    } as unknown as ReposAppRequest;
    const res = createResponse();
    (res as any).locals = {};
    const next = vi.fn() as unknown as NextFunction;

    sessionCsrfProtection(req, res, next);

    expect((next as any).mock.calls[0][0].statusCode).toBe(403);
    expect((next as any).mock.calls[0][0].message).toBe('Invalid request origin');
    expect(insights.trackEvent).toHaveBeenCalledWith({
      name: 'CsrfInvalidOrigin',
      properties: {
        reason: 'origin',
        method: 'POST',
        url: '/api/client/ping',
        origin: 'https://evil.example',
        expectedOrigin: 'https://portal.example',
        host: 'portal.example',
        forwardedHost: '',
        protocol: 'https',
        forwardedProto: '',
        referer: '',
        secFetchSite: '',
        secFetchMode: '',
        secFetchDest: '',
        correlationId: 'corr-123',
      },
    });
  });

  it('rejects unsafe requests flagged as cross-site by fetch metadata', () => {
    const session = { csrfToken: 'known-token' } as IAppSession;
    const insights = createInsights();
    const req = {
      method: 'POST',
      protocol: 'https',
      session,
      originalUrl: '/api/client/ping',
      insights,
      body: {},
      header: vi.fn((name: string) => {
        if (name === CSRF_HEADER_NAME) {
          return 'known-token';
        }
        if (name === 'origin') {
          return 'https://portal.example';
        }
        if (name === 'host') {
          return 'portal.example';
        }
        if (name === 'sec-fetch-site') {
          return 'cross-site';
        }
        return undefined;
      }),
      is: vi.fn().mockReturnValue(false),
    } as unknown as ReposAppRequest;
    const res = createResponse();
    (res as any).locals = {};
    const next = vi.fn() as unknown as NextFunction;

    sessionCsrfProtection(req, res, next);

    expect((next as any).mock.calls[0][0].statusCode).toBe(403);
    expect((next as any).mock.calls[0][0].message).toBe('Invalid request origin');
    expect(insights.trackEvent).toHaveBeenCalledWith({
      name: 'CsrfInvalidOrigin',
      properties: {
        reason: 'fetch_metadata',
        method: 'POST',
        url: '/api/client/ping',
        origin: 'https://portal.example',
        expectedOrigin: 'https://portal.example',
        host: 'portal.example',
        forwardedHost: '',
        protocol: 'https',
        forwardedProto: '',
        referer: '',
        secFetchSite: 'cross-site',
        secFetchMode: '',
        secFetchDest: '',
        correlationId: '',
      },
    });
  });

  it('Azure Front Door: allows request when trust proxy is enabled and origin matches x-forwarded-host', () => {
    // Simulates Azure Front Door: the public hostname is set via x-forwarded-host while
    // the internal host header contains the backend hostname (e.g. *.azurewebsites.net).
    // With trust proxy enabled, getEffectiveHost should prefer x-forwarded-host so the
    // origin check succeeds against the public-facing hostname.
    const session = { csrfToken: 'known-token' } as IAppSession;
    const req = {
      method: 'POST',
      protocol: 'https',
      session,
      body: {},
      app: { get: (key: string) => (key === 'trust proxy' ? true : undefined) },
      header: vi.fn((name: string) => {
        if (name === CSRF_HEADER_NAME) {
          return 'known-token';
        }
        if (name === 'origin') {
          return 'https://repos.dev.opensource.ms';
        }
        if (name === 'host') {
          return 'backend.azurewebsites.net';
        }
        if (name === 'x-forwarded-host') {
          return 'repos.dev.opensource.ms';
        }
        return undefined;
      }),
      is: vi.fn().mockReturnValue(false),
    } as unknown as ReposAppRequest;
    const res = createResponse();
    (res as any).locals = {};
    const next = vi.fn() as unknown as NextFunction;

    sessionCsrfProtection(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect((next as any).mock.calls[0][0]).toBeUndefined();
  });

  it('Azure Front Door: rejects request when trust proxy is disabled because x-forwarded-host is ignored', () => {
    // Simulates Azure Front Door headers arriving at an app where trust proxy is NOT
    // enabled. getEffectiveHost must fall back to the Host header (backend hostname)
    // rather than trusting the client-supplied x-forwarded-host. The origin
    // (public hostname) will therefore not match, and the request must be rejected.
    const session = { csrfToken: 'known-token' } as IAppSession;
    const req = {
      method: 'POST',
      protocol: 'https',
      session,
      body: {},
      app: { get: (_key: string) => undefined },
      header: vi.fn((name: string) => {
        if (name === CSRF_HEADER_NAME) {
          return 'known-token';
        }
        if (name === 'origin') {
          return 'https://repos.dev.opensource.ms';
        }
        if (name === 'host') {
          return 'backend.azurewebsites.net';
        }
        if (name === 'x-forwarded-host') {
          return 'repos.dev.opensource.ms';
        }
        return undefined;
      }),
      is: vi.fn().mockReturnValue(false),
    } as unknown as ReposAppRequest;
    const res = createResponse();
    (res as any).locals = {};
    const next = vi.fn() as unknown as NextFunction;

    sessionCsrfProtection(req, res, next);

    expect((next as any).mock.calls[0][0].statusCode).toBe(403);
    expect((next as any).mock.calls[0][0].message).toBe('Invalid request origin');
  });

  it('re-mints a token after the previous session token is cleared', () => {
    const session = { csrfToken: 'known-token' } as IAppSession;

    clearSessionCsrfToken(session);

    const req = {
      method: 'GET',
      session,
      header: vi.fn(),
    } as unknown as ReposAppRequest;
    const res = createResponse();
    (res as any).locals = {};
    const next = vi.fn() as unknown as NextFunction;

    sessionCsrfProtection(req, res, next);

    expect(session.csrfToken).toBeTruthy();
    expect(session.csrfToken).not.toBe('known-token');
    expect(next).toHaveBeenCalledOnce();
    expect((next as any).mock.calls[0][0]).toBeUndefined();
  });
});
