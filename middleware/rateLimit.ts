//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import crypto from 'crypto';

import type { NextFunction, RequestHandler, Response } from 'express';

import type { ApiRequestToken, IProviders, ReposAppRequest, SiteConfiguration } from '../interfaces/index.js';
import type { ICacheHelper } from '../lib/caching/index.js';
import MemoryCacheHelper from '../lib/caching/memory.js';
import { CreateError } from '../lib/transitional.js';

const AUDIT_CACHE_KEY_PREFIX = 'ratelimit:audit';
const PRE_AUTH_AUDIT_CACHE_KEY_PREFIX = 'ratelimit:preauth:audit';
const TELEMETRY_PREFIX = 'web.rate_limit.audit';
const PRE_AUTH_TELEMETRY_PREFIX = 'web.rate_limit.pre_auth.audit';
const DEFAULT_AUDIT_MODE = 'disabled';
const DEFAULT_WINDOW_SECONDS = 60;
const DEFAULT_THRESHOLD = 120;
const DEFAULT_SAMPLE_RATE = 0.05;

let hasLoggedMemoryFallbackCacheProvider = false;

type RateLimitAuditCounter = {
  count: number;
};

type AuditSettings = {
  enabled: boolean;
  enforce: boolean;
  windowSeconds: number;
  thresholdSessionAuthenticated: number;
  thresholdApiAuthorized: number;
  thresholdUnauthenticated: number;
  sampleRate: number;
  includePathInKey: boolean;
  includeMethodInKey: boolean;
};

type AuthTier = 'session_authenticated' | 'api_authorized' | 'unauthenticated';

type RateLimitMiddlewareOptions = {
  authTierMode?: 'resolved' | 'unauthenticated';
  identityMode?: 'resolved' | 'network';
  enforceMode?: 'config' | 'never';
  cacheKeyPrefix?: string;
  telemetryPrefix?: string;
  requestPhase?: 'pre_auth' | 'post_auth';
};

type RequestWithOptionalApiKeyToken = ReposAppRequest & {
  apiKeyToken?: ApiRequestToken;
};

function clampAuditSettings(config: SiteConfiguration): AuditSettings {
  const mode = config?.rateLimit?.mode || DEFAULT_AUDIT_MODE;
  const configuredSampleRate = Number(config?.rateLimit?.audit?.sampleRate ?? DEFAULT_SAMPLE_RATE);
  const sampleRate = Number.isFinite(configuredSampleRate)
    ? Math.min(Math.max(configuredSampleRate, 0), 1)
    : DEFAULT_SAMPLE_RATE;
  const threshold = Math.max(config?.rateLimit?.audit?.threshold ?? DEFAULT_THRESHOLD, 1);
  const thresholdAuthenticatedLegacy = Math.max(
    config?.rateLimit?.audit?.thresholdAuthenticated ?? threshold,
    1
  );
  const thresholdSessionAuthenticated = Math.max(
    config?.rateLimit?.audit?.thresholdSessionAuthenticated ?? thresholdAuthenticatedLegacy,
    1
  );
  const thresholdApiAuthorized = Math.max(
    config?.rateLimit?.audit?.thresholdApiAuthorized ?? thresholdAuthenticatedLegacy,
    1
  );
  const thresholdUnauthenticated = Math.max(
    config?.rateLimit?.audit?.thresholdUnauthenticated ?? threshold,
    1
  );

  return {
    enabled: (mode === 'audit' || mode === 'enforce') && config?.rateLimit?.audit?.enabled === true,
    enforce: mode === 'enforce',
    windowSeconds: Math.max(config?.rateLimit?.audit?.windowSeconds ?? DEFAULT_WINDOW_SECONDS, 1),
    thresholdSessionAuthenticated,
    thresholdApiAuthorized,
    thresholdUnauthenticated,
    sampleRate,
    includePathInKey: config?.rateLimit?.audit?.includePathInKey !== false,
    includeMethodInKey: config?.rateLimit?.audit?.includeMethodInKey !== false,
  };
}

function isSessionAuthenticatedRequest(req: ReposAppRequest): boolean {
  if (typeof req.isAuthenticated === 'function' && req.isAuthenticated()) {
    return true;
  }

  return !!(req?.user?.github?.id || req?.user?.azure?.oid);
}

function isApiAuthorizedRequest(req: ReposAppRequest): boolean {
  const apiToken = (req as RequestWithOptionalApiKeyToken).apiKeyToken;
  if (!apiToken) {
    return false;
  }
  return apiToken.hasAnyScope && apiToken.hasAnyScope();
}

function resolveAuthTier(req: ReposAppRequest): AuthTier {
  if (isApiAuthorizedRequest(req)) {
    return 'api_authorized';
  }
  if (isSessionAuthenticatedRequest(req)) {
    return 'session_authenticated';
  }
  return 'unauthenticated';
}

function resolveThreshold(settings: AuditSettings, authTier: AuthTier): number {
  if (authTier === 'api_authorized') {
    return settings.thresholdApiAuthorized;
  }
  if (authTier === 'session_authenticated') {
    return settings.thresholdSessionAuthenticated;
  }
  return settings.thresholdUnauthenticated;
}

export function normalizePath(req: ReposAppRequest): string {
  const path = req.scrubbedUrl || req.originalUrl || req.url || 'unknown-path';
  return path.split('?')[0] || 'unknown-path';
}

function resolveIdentity(req: ReposAppRequest): string {
  const apiToken = (req as RequestWithOptionalApiKeyToken).apiKeyToken;
  const apiClientId = apiToken?.token?.clientId;
  const apiObjectId = apiToken?.token?.objectId;
  if (apiClientId || apiObjectId) {
    return `api:${apiClientId || 'unknown-client'}:${apiObjectId || 'unknown-object'}`;
  }

  const githubId = req?.user?.github?.id;
  const azureOid = req?.user?.azure?.oid;
  if (githubId) {
    return `github:${githubId}`;
  }
  if (azureOid) {
    return `azure:${azureOid}`;
  }

  return resolveNetworkIdentity(req);
}

function resolveNetworkIdentity(req: ReposAppRequest): string {
  const clientIpFromTrustedChain = Array.isArray(req.ips) && req.ips.length > 0 ? req.ips[0] : undefined;
  const ip = clientIpFromTrustedChain || req.ip || req.socket?.remoteAddress || 'unknown-ip';
  return `ip:${ip}`;
}

function hashValue(value: string): string {
  // Compacts an unbounded cache key into a fixed-length stable identifier.
  // NOT used for password storage, authentication, or secret comparison.
  return crypto.createHash('sha256').update(value).digest('hex');
}

function shouldSample(sampleRate: number, count: number): boolean {
  if (sampleRate <= 0) {
    return false;
  }
  if (sampleRate >= 1) {
    return true;
  }
  const sampleEvery = Math.max(Math.round(1 / sampleRate), 1);
  return count % sampleEvery === 0;
}

function createKey(
  req: ReposAppRequest,
  settings: AuditSettings,
  windowBucket: number,
  options: RateLimitMiddlewareOptions
): string {
  const id = options.identityMode === 'network' ? resolveNetworkIdentity(req) : resolveIdentity(req);
  const path = settings.includePathInKey ? normalizePath(req) : '';
  const method = settings.includeMethodInKey ? req.method || 'UNKNOWN' : '';
  const unboundedKey = `${id}|${path}|${method}|${windowBucket}`;
  const cacheKeyPrefix = options.cacheKeyPrefix || AUDIT_CACHE_KEY_PREFIX;
  return `${cacheKeyPrefix}:${hashValue(unboundedKey)}`;
}

function getRetryAfterSeconds(now: number, windowMs: number, windowBucket: number): number {
  const nextWindowStart = (windowBucket + 1) * windowMs;
  return Math.max(1, Math.ceil((nextWindowStart - now) / 1000));
}

function createRateLimitMiddleware(
  providers: IProviders,
  config: SiteConfiguration,
  options: RateLimitMiddlewareOptions = {}
) {
  const settings = clampAuditSettings(config);
  let fallbackCacheProvider: ICacheHelper = null;
  if (!settings.enabled) {
    return (_req: ReposAppRequest, _res: Response, next: NextFunction) => next();
  }

  const telemetryPrefix = options.telemetryPrefix || TELEMETRY_PREFIX;
  const requestPhase = options.requestPhase || 'post_auth';

  function getRateLimitCacheProvider() {
    if (providers.cacheProvider) {
      return providers.cacheProvider;
    }

    if (!fallbackCacheProvider) {
      fallbackCacheProvider = new MemoryCacheHelper();
      if (!hasLoggedMemoryFallbackCacheProvider) {
        providers.genericInsights?.trackEvent({
          name: `${telemetryPrefix}.cache_provider.memory_fallback`,
        });
        hasLoggedMemoryFallbackCacheProvider = true;
      }
    }

    return fallbackCacheProvider;
  }

  return async function rateLimitAudit(req: ReposAppRequest, res: Response, next: NextFunction) {
    const cacheProvider = getRateLimitCacheProvider();

    const now = Date.now();
    const windowMs = settings.windowSeconds * 1000;
    const windowBucket = Math.floor(now / windowMs);
    const key = createKey(req, settings, windowBucket, options);
    const windowMinutesToExpire = Math.max(1, Math.ceil(settings.windowSeconds / 60));

    try {
      let count: number;
      if (
        cacheProvider.supportsIncrementWithExpire &&
        typeof cacheProvider.incrementWithExpire === 'function'
      ) {
        count = await cacheProvider.incrementWithExpire(key, windowMinutesToExpire);
      } else {
        const current = await cacheProvider.getObject<RateLimitAuditCounter>(key);
        count = (current?.count || 0) + 1;
        await cacheProvider.setObjectWithExpire(key, { count }, windowMinutesToExpire);
      }

      const authTier = options.authTierMode === 'unauthenticated' ? 'unauthenticated' : resolveAuthTier(req);
      const threshold = resolveThreshold(settings, authTier);
      const sampled = shouldSample(settings.sampleRate, count);
      const thresholdExceeded = count > threshold;

      if (sampled || thresholdExceeded) {
        const properties = {
          correlationId: req.correlationId || '',
          method: req.method || '',
          path: normalizePath(req),
          authTier,
          threshold: `${threshold}`,
          windowSeconds: `${settings.windowSeconds}`,
          requestPhase,
          sampled: `${sampled}`,
          thresholdExceeded: `${thresholdExceeded}`,
        };

        req.insights?.trackMetric({
          name: `${telemetryPrefix}.request_count`,
          value: count,
          properties,
        });
      }

      if (thresholdExceeded) {
        req.insights?.trackMetric({
          name: `${telemetryPrefix}.threshold_exceeded`,
          value: 1,
          properties: {
            correlationId: req.correlationId || '',
            method: req.method || '',
            path: normalizePath(req),
            authTier,
            threshold: `${threshold}`,
            windowSeconds: `${settings.windowSeconds}`,
            requestPhase,
          },
        });
        req.insights?.trackEvent({
          name: `${telemetryPrefix}.threshold_exceeded`,
          properties: {
            correlationId: req.correlationId || '',
            method: req.method || '',
            path: normalizePath(req),
            authTier,
            observedCount: `${count}`,
            threshold: `${threshold}`,
            windowSeconds: `${settings.windowSeconds}`,
            requestPhase,
          },
        });

        const shouldEnforce = options.enforceMode === 'never' ? false : settings.enforce;
        if (shouldEnforce) {
          const retryAfterSeconds = getRetryAfterSeconds(now, windowMs, windowBucket);
          res.setHeader('Retry-After', `${retryAfterSeconds}`);
          return next(
            CreateError.CreateStatusCodeError(
              429,
              `Rate limit exceeded. Retry after ${retryAfterSeconds} seconds.`
            )
          );
        }
      }
    } catch (error) {
      req.insights?.trackException({
        exception: error as Error,
        properties: {
          correlationId: req.correlationId || '',
          path: normalizePath(req),
          method: req.method || '',
        },
      });
    }

    return next();
  };
}

export function createRateLimitAuditMiddleware(providers: IProviders, config: SiteConfiguration) {
  return createRateLimitMiddleware(providers, config, {
    authTierMode: 'resolved',
    identityMode: 'resolved',
    enforceMode: 'config',
    cacheKeyPrefix: AUDIT_CACHE_KEY_PREFIX,
    telemetryPrefix: TELEMETRY_PREFIX,
    requestPhase: 'post_auth',
  });
}

export function createPreAuthRateLimitAuditMiddleware(providers: IProviders, config: SiteConfiguration) {
  return createRateLimitMiddleware(providers, config, {
    authTierMode: 'unauthenticated',
    identityMode: 'network',
    enforceMode: 'never',
    cacheKeyPrefix: PRE_AUTH_AUDIT_CACHE_KEY_PREFIX,
    telemetryPrefix: PRE_AUTH_TELEMETRY_PREFIX,
    requestPhase: 'pre_auth',
  });
}

export function getRateLimitMiddleware(providers: IProviders, config: SiteConfiguration): RequestHandler {
  if (!providers.rateLimitMiddleware) {
    providers.rateLimitMiddleware = createRateLimitAuditMiddleware(providers, config);
  }
  return providers.rateLimitMiddleware;
}

export function getPreAuthRateLimitMiddleware(
  providers: IProviders,
  config: SiteConfiguration
): RequestHandler {
  if (!providers.preAuthRateLimitMiddleware) {
    providers.preAuthRateLimitMiddleware = createPreAuthRateLimitAuditMiddleware(providers, config);
  }
  return providers.preAuthRateLimitMiddleware;
}
