//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { randomUUID, timingSafeEqual } from 'crypto';
import { NextFunction, Response } from 'express';

import { CreateError } from '../../lib/transitional.js';

import type { IAppSession, ReposAppRequest } from '../../interfaces/index.js';

const CSRF_HEADER_NAME = 'x-csrf-token';
const CSRF_BODY_FIELD_NAME = '_csrf';
const CSRF_CACHE_CONTROL_DIRECTIVES = ['private', 'no-store'];
const CSRF_INVALID_ORIGIN_EVENT = 'CsrfInvalidOrigin';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TRUSTED_FETCH_SITES = new Set(['same-origin', 'same-site', 'none']);

export function clearSessionCsrfToken(session?: IAppSession): void {
  if (session?.csrfToken) {
    delete session.csrfToken;
  }
}

function ensureSessionCsrfToken(session: IAppSession): string {
  if (!session.csrfToken) {
    session.csrfToken = randomUUID();
  }
  return session.csrfToken;
}

function isSafeMethod(method?: string): boolean {
  return SAFE_METHODS.has((method || 'GET').toUpperCase());
}

function matchesSessionToken(sessionToken: string, requestToken?: string): boolean {
  if (!requestToken) {
    return false;
  }
  const sessionBuffer = Buffer.from(sessionToken);
  const requestBuffer = Buffer.from(requestToken);
  if (sessionBuffer.length !== requestBuffer.length) {
    return false;
  }
  return timingSafeEqual(sessionBuffer, requestBuffer);
}

function getEffectiveHost(req: ReposAppRequest): string | undefined {
  // Only honor x-forwarded-host when Express trust proxy is enabled;
  // the header is otherwise client-controlled and must not be trusted.
  if (req.app?.get('trust proxy')) {
    const forwarded = req.header('x-forwarded-host');
    if (forwarded) {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.header('host');
}

function isTrustedOrigin(req: ReposAppRequest): boolean {
  const origin = req.header('origin');
  if (!origin) {
    return true;
  }

  const host = getEffectiveHost(req);
  if (!host) {
    return false;
  }

  try {
    return new URL(origin).origin === `${req.protocol}://${host}`;
  } catch {
    return false;
  }
}

function hasTrustedFetchMetadata(req: ReposAppRequest): boolean {
  const fetchSite = req.header('sec-fetch-site');
  if (!fetchSite) {
    return true;
  }

  return TRUSTED_FETCH_SITES.has(fetchSite.toLowerCase());
}

function getExpectedOrigin(req: ReposAppRequest): string | undefined {
  const host = getEffectiveHost(req);
  if (!host) {
    return undefined;
  }

  return `${req.protocol}://${host}`;
}

function trackInvalidOrigin(req: ReposAppRequest, reason: 'origin' | 'fetch_metadata'): void {
  req.insights?.trackEvent({
    name: CSRF_INVALID_ORIGIN_EVENT,
    properties: {
      reason,
      method: req.method || '',
      url: req.originalUrl || req.url || '',
      origin: req.header('origin') || '',
      expectedOrigin: getExpectedOrigin(req) || '',
      host: req.header('host') || '',
      forwardedHost: req.header('x-forwarded-host') || '',
      protocol: req.protocol || '',
      forwardedProto: req.header('x-forwarded-proto') || '',
      referer: req.header('referer') || '',
      secFetchSite: req.header('sec-fetch-site') || '',
      secFetchMode: req.header('sec-fetch-mode') || '',
      secFetchDest: req.header('sec-fetch-dest') || '',
      correlationId: req.correlationId || '',
    },
  });
}

function isFormRequest(req: ReposAppRequest): boolean {
  const urlEncodedMatch = req.is?.('application/x-www-form-urlencoded');
  const multipartMatch = req.is?.('multipart/form-data');
  return urlEncodedMatch !== undefined && urlEncodedMatch !== false
    ? true
    : multipartMatch !== undefined && multipartMatch !== false;
}

function appendCacheControlDirective(currentValue: unknown, directive: string): string {
  const normalized = Array.isArray(currentValue) ? currentValue.join(', ') : String(currentValue || '');
  const existingDirectives = normalized
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (existingDirectives.includes(directive)) {
    return existingDirectives.join(', ');
  }
  return [...existingDirectives, directive].join(', ');
}

function setTokenResponseHeaders(res: Response, sessionToken: string): void {
  res.setHeader(CSRF_HEADER_NAME, sessionToken);

  let cacheControl = res.getHeader('Cache-Control');
  for (const directive of CSRF_CACHE_CONTROL_DIRECTIVES) {
    cacheControl = appendCacheControlDirective(cacheControl, directive);
  }

  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('Pragma', 'no-cache');
}

function getRequestToken(req: ReposAppRequest): string | undefined {
  const headerToken = req.header(CSRF_HEADER_NAME);
  if (headerToken) {
    return headerToken;
  }

  if (!isFormRequest(req)) {
    return undefined;
  }

  const body = req.body as Record<string, unknown> | undefined;
  const bodyToken = body?.[CSRF_BODY_FIELD_NAME];
  return typeof bodyToken === 'string' ? bodyToken : undefined;
}

function csrfError(req: ReposAppRequest, message: string, statusCode: number): Error {
  if (req.originalUrl?.startsWith('/api/')) {
    return CreateError.CreateStatusCodeError(statusCode, message);
  }
  const err = new Error(message) as Error & { statusCode?: number; status?: number };
  err.statusCode = statusCode;
  err.status = statusCode;
  return err;
}

export function sessionCsrfProtection(req: ReposAppRequest, res: Response, next: NextFunction) {
  const session = req.session as IAppSession | undefined;
  if (!session) {
    return next(CreateError.ServerError('Session is required for CSRF protection'));
  }

  const sessionToken = ensureSessionCsrfToken(session);
  setTokenResponseHeaders(res, sessionToken);
  res.locals.csrfToken = sessionToken;

  if (isSafeMethod(req.method)) {
    return next();
  }

  if (!isTrustedOrigin(req)) {
    trackInvalidOrigin(req, 'origin');
    return next(csrfError(req, 'Invalid request origin', 403));
  }

  if (!hasTrustedFetchMetadata(req)) {
    trackInvalidOrigin(req, 'fetch_metadata');
    return next(csrfError(req, 'Invalid request origin', 403));
  }

  const requestToken = getRequestToken(req);
  if (!matchesSessionToken(sessionToken, requestToken)) {
    return next(csrfError(req, 'Invalid or missing CSRF token', 403));
  }

  return next();
}

export { CSRF_BODY_FIELD_NAME, CSRF_HEADER_NAME };
