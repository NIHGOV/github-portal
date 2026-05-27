//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { describe, expect, it, vi } from 'vitest';

import {
  createPreAuthRateLimitAuditMiddleware,
  createRateLimitAuditMiddleware,
  getPreAuthRateLimitMiddleware,
  getRateLimitMiddleware,
  normalizePath,
} from './rateLimit.js';

import type { ReposAppRequest, SiteConfiguration } from '../interfaces/index.js';

describe('normalizePath', () => {
  it('prefers scrubbedUrl when present', () => {
    const req = createRequest({ scrubbedUrl: '/scrubbed/path', originalUrl: '/original/path' } as any);
    expect(normalizePath(req)).toBe('/scrubbed/path');
  });

  it('uses originalUrl over url to preserve full mount path', () => {
    const req = createRequest({ originalUrl: '/api/ping', url: '/ping' });
    expect(normalizePath(req)).toBe('/api/ping');
  });

  it('does not use req.path (avoids mount-relative paths)', () => {
    const req = createRequest({ path: '/ping', originalUrl: '/api/ping' });
    expect(normalizePath(req)).toBe('/api/ping');
  });

  it('falls back to req.url when originalUrl is missing', () => {
    const req = createRequest({ originalUrl: undefined as any, url: '/fallback' });
    expect(normalizePath(req)).toBe('/fallback');
  });

  it('strips query strings', () => {
    const req = createRequest({ originalUrl: '/api/test?foo=bar&baz=1' });
    expect(normalizePath(req)).toBe('/api/test');
  });

  it('returns unknown-path when no URL properties are set', () => {
    const req = createRequest({
      originalUrl: undefined as any,
      url: undefined as any,
      path: undefined as any,
    } as any);
    expect(normalizePath(req)).toBe('unknown-path');
  });
});

function createConfiguration(overrides?: Partial<SiteConfiguration>): SiteConfiguration {
  return {
    rateLimit: {
      mode: 'audit',
      audit: {
        enabled: true,
        windowSeconds: 60,
        threshold: 2,
        thresholdAuthenticated: 2,
        thresholdSessionAuthenticated: 2,
        thresholdApiAuthorized: 2,
        thresholdUnauthenticated: 2,
        sampleRate: 1,
        includePathInKey: true,
        includeMethodInKey: true,
      },
    },
    ...(overrides || {}),
  } as SiteConfiguration;
}

function createRequest(overrides?: Partial<ReposAppRequest>): ReposAppRequest {
  return {
    method: 'GET',
    path: '/api/test',
    originalUrl: '/api/test',
    correlationId: 'corr-123',
    ip: '10.0.0.1',
    user: {} as any,
    header: vi.fn().mockReturnValue(undefined),
    insights: {
      trackMetric: vi.fn(),
      trackEvent: vi.fn(),
      trackException: vi.fn(),
    } as any,
    ...(overrides || {}),
  } as ReposAppRequest;
}

function createResponse() {
  return {
    setHeader: vi.fn(),
  } as any;
}

describe('createRateLimitAuditMiddleware', () => {
  it('reuses the rate-limit middleware stored on providers', () => {
    const providers = {
      cacheProvider: {
        getObject: vi.fn(),
        setObjectWithExpire: vi.fn(),
      },
    } as any;
    const config = createConfiguration();

    const middlewareA = getRateLimitMiddleware(providers, config);
    const middlewareB = getRateLimitMiddleware(providers, config);

    expect(middlewareA).toBe(middlewareB);
    expect(providers.rateLimitMiddleware).toBe(middlewareA);
  });

  it('reuses the pre-auth rate-limit middleware stored on providers', () => {
    const providers = {
      cacheProvider: {
        getObject: vi.fn(),
        setObjectWithExpire: vi.fn(),
      },
    } as any;
    const config = createConfiguration();

    const middlewareA = getPreAuthRateLimitMiddleware(providers, config);
    const middlewareB = getPreAuthRateLimitMiddleware(providers, config);

    expect(middlewareA).toBe(middlewareB);
    expect(providers.preAuthRateLimitMiddleware).toBe(middlewareA);
  });

  it('falls back to an in-memory cache provider when no shared cache provider exists', async () => {
    const providers = {
      genericInsights: {
        trackEvent: vi.fn(),
      },
    } as any;
    const config = createConfiguration({
      rateLimit: {
        mode: 'audit',
        audit: {
          enabled: true,
          windowSeconds: 60,
          threshold: 100,
          thresholdAuthenticated: 100,
          thresholdSessionAuthenticated: 100,
          thresholdApiAuthorized: 100,
          thresholdUnauthenticated: 2,
          sampleRate: 0,
          includePathInKey: true,
          includeMethodInKey: true,
        },
      },
    });
    const middleware = createRateLimitAuditMiddleware(providers, config);
    const req = createRequest({
      user: undefined as any,
      isAuthenticated: vi.fn().mockReturnValue(false) as any,
    });

    await middleware(req, {} as any, vi.fn());
    await middleware(req, {} as any, vi.fn());
    await middleware(req, {} as any, vi.fn());

    expect(providers.genericInsights.trackEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'web.rate_limit.audit.cache_provider.memory_fallback',
      })
    );
    expect(req.insights?.trackEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'web.rate_limit.audit.threshold_exceeded',
      })
    );
  });

  it('does nothing when rate limiting is disabled', async () => {
    const cacheProvider = {
      getObject: vi.fn(),
      setObjectWithExpire: vi.fn(),
    };
    const providers = {
      cacheProvider,
    } as any;
    const config = {
      rateLimit: {
        mode: 'disabled',
        audit: {
          enabled: true,
          thresholdAuthenticated: 2,
          thresholdSessionAuthenticated: 2,
          thresholdApiAuthorized: 2,
          thresholdUnauthenticated: 2,
        },
      },
    } as SiteConfiguration;

    const middleware = createRateLimitAuditMiddleware(providers, config);
    const req = createRequest();
    const next = vi.fn();

    await middleware(req, {} as any, next);

    expect(cacheProvider.getObject).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('tracks sampled metric and threshold exceeded telemetry in audit mode', async () => {
    const cacheStore = new Map<string, { count: number }>();
    const cacheProvider = {
      getObject: vi.fn(async (key: string) => cacheStore.get(key)),
      setObjectWithExpire: vi.fn(async (key: string, value: { count: number }) => {
        cacheStore.set(key, value);
      }),
    };
    const providers = {
      cacheProvider,
    } as any;
    const config = createConfiguration();
    const middleware = createRateLimitAuditMiddleware(providers, config);
    const req = createRequest();

    const nextA = vi.fn();
    await middleware(req, {} as any, nextA);
    const nextB = vi.fn();
    await middleware(req, {} as any, nextB);
    const nextC = vi.fn();
    await middleware(req, {} as any, nextC);

    expect((req.insights?.trackMetric as any).mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(req.insights?.trackEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'web.rate_limit.audit.threshold_exceeded',
      })
    );
    expect(nextA).toHaveBeenCalledOnce();
    expect(nextB).toHaveBeenCalledOnce();
    expect(nextC).toHaveBeenCalledOnce();
  });

  it('allows requests under the threshold in enforce mode', async () => {
    const cacheStore = new Map<string, { count: number }>();
    const cacheProvider = {
      getObject: vi.fn(async (key: string) => cacheStore.get(key)),
      setObjectWithExpire: vi.fn(async (key: string, value: { count: number }) => {
        cacheStore.set(key, value);
      }),
    };
    const providers = {
      cacheProvider,
    } as any;
    const config = createConfiguration({
      rateLimit: {
        mode: 'enforce',
        audit: {
          enabled: true,
          windowSeconds: 60,
          threshold: 2,
          thresholdAuthenticated: 2,
          thresholdSessionAuthenticated: 2,
          thresholdApiAuthorized: 2,
          thresholdUnauthenticated: 2,
          sampleRate: 0,
          includePathInKey: true,
          includeMethodInKey: true,
        },
      },
    });
    const middleware = createRateLimitAuditMiddleware(providers, config);
    const req = createRequest();
    const res = createResponse();
    const next = vi.fn();

    await middleware(req, res, next);
    await middleware(req, res, next);

    expect(next).toHaveBeenNthCalledWith(1);
    expect(next).toHaveBeenNthCalledWith(2);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('blocks requests over the threshold in enforce mode with retry-after', async () => {
    const cacheStore = new Map<string, { count: number }>();
    const cacheProvider = {
      getObject: vi.fn(async (key: string) => cacheStore.get(key)),
      setObjectWithExpire: vi.fn(async (key: string, value: { count: number }) => {
        cacheStore.set(key, value);
      }),
    };
    const providers = {
      cacheProvider,
    } as any;
    const config = createConfiguration({
      rateLimit: {
        mode: 'enforce',
        audit: {
          enabled: true,
          windowSeconds: 60,
          threshold: 2,
          thresholdAuthenticated: 2,
          thresholdSessionAuthenticated: 2,
          thresholdApiAuthorized: 2,
          thresholdUnauthenticated: 2,
          sampleRate: 0,
          includePathInKey: true,
          includeMethodInKey: true,
        },
      },
    });
    const middleware = createRateLimitAuditMiddleware(providers, config);
    const req = createRequest();
    const res = createResponse();
    const nextA = vi.fn();
    const nextB = vi.fn();
    const nextC = vi.fn();

    await middleware(req, res, nextA);
    await middleware(req, res, nextB);
    await middleware(req, res, nextC);

    expect(nextA).toHaveBeenCalledOnce();
    expect(nextA).toHaveBeenCalledWith();
    expect(nextB).toHaveBeenCalledOnce();
    expect(nextB).toHaveBeenCalledWith();
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
    expect(nextC).toHaveBeenCalledOnce();
    expect(nextC).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 429,
        statusCode: 429,
        message: expect.stringContaining('Rate limit exceeded.'),
      })
    );
    expect(req.insights?.trackEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'web.rate_limit.audit.threshold_exceeded',
      })
    );
  });

  it('uses cache and writes a counter object with expiration', async () => {
    const cacheProvider = {
      getObject: vi.fn(async () => ({ count: 5 })),
      setObjectWithExpire: vi.fn(async () => {}),
    };
    const providers = {
      cacheProvider,
    } as any;
    const config = createConfiguration({
      rateLimit: {
        mode: 'audit',
        audit: {
          enabled: true,
          windowSeconds: 90,
          threshold: 100,
          thresholdAuthenticated: 100,
          thresholdSessionAuthenticated: 100,
          thresholdApiAuthorized: 100,
          thresholdUnauthenticated: 100,
          sampleRate: 1,
          includePathInKey: false,
          includeMethodInKey: false,
        },
      },
    });
    const middleware = createRateLimitAuditMiddleware(providers, config);
    const req = createRequest({
      path: '/api/other',
      method: 'POST',
    });
    const next = vi.fn();

    await middleware(req, {} as any, next);

    expect(cacheProvider.getObject).toHaveBeenCalledOnce();
    expect(cacheProvider.setObjectWithExpire).toHaveBeenCalledWith(expect.any(String), { count: 6 }, 2);
    expect(next).toHaveBeenCalledOnce();
  });

  it('uses incrementWithExpire when the cache provider supports it', async () => {
    const cacheProvider = {
      supportsIncrementWithExpire: true,
      incrementWithExpire: vi.fn(async () => 6),
      getObject: vi.fn(),
      setObjectWithExpire: vi.fn(),
    };
    const providers = {
      cacheProvider,
    } as any;
    const config = createConfiguration({
      rateLimit: {
        mode: 'audit',
        audit: {
          enabled: true,
          windowSeconds: 90,
          threshold: 100,
          thresholdAuthenticated: 100,
          thresholdSessionAuthenticated: 100,
          thresholdApiAuthorized: 100,
          thresholdUnauthenticated: 100,
          sampleRate: 1,
          includePathInKey: false,
          includeMethodInKey: false,
        },
      },
    });
    const middleware = createRateLimitAuditMiddleware(providers, config);
    const req = createRequest({
      path: '/api/other',
      method: 'POST',
    });
    const next = vi.fn();

    await middleware(req, {} as any, next);

    expect(cacheProvider.incrementWithExpire).toHaveBeenCalledWith(expect.any(String), 2);
    expect(cacheProvider.getObject).not.toHaveBeenCalled();
    expect(cacheProvider.setObjectWithExpire).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it('applies unauthenticated threshold when request is not authenticated', async () => {
    const cacheStore = new Map<string, { count: number }>();
    const cacheProvider = {
      getObject: vi.fn(async (key: string) => cacheStore.get(key)),
      setObjectWithExpire: vi.fn(async (key: string, value: { count: number }) => {
        cacheStore.set(key, value);
      }),
    };
    const providers = {
      cacheProvider,
    } as any;
    const config = createConfiguration({
      rateLimit: {
        mode: 'audit',
        audit: {
          enabled: true,
          windowSeconds: 60,
          threshold: 100,
          thresholdAuthenticated: 100,
          thresholdSessionAuthenticated: 100,
          thresholdApiAuthorized: 100,
          thresholdUnauthenticated: 2,
          sampleRate: 0,
          includePathInKey: true,
          includeMethodInKey: true,
        },
      },
    });
    const middleware = createRateLimitAuditMiddleware(providers, config);
    const req = createRequest({
      user: undefined as any,
      isAuthenticated: vi.fn().mockReturnValue(false) as any,
    });

    await middleware(req, {} as any, vi.fn());
    await middleware(req, {} as any, vi.fn());
    await middleware(req, {} as any, vi.fn());

    expect(req.insights?.trackEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'web.rate_limit.audit.threshold_exceeded',
        properties: expect.objectContaining({
          authTier: 'unauthenticated',
          threshold: '2',
        }),
      })
    );
  });

  it('applies session-authenticated threshold when request has a signed-in user', async () => {
    const cacheStore = new Map<string, { count: number }>();
    const cacheProvider = {
      getObject: vi.fn(async (key: string) => cacheStore.get(key)),
      setObjectWithExpire: vi.fn(async (key: string, value: { count: number }) => {
        cacheStore.set(key, value);
      }),
    };
    const providers = {
      cacheProvider,
    } as any;
    const config = createConfiguration({
      rateLimit: {
        mode: 'audit',
        audit: {
          enabled: true,
          windowSeconds: 60,
          threshold: 100,
          thresholdAuthenticated: 100,
          thresholdSessionAuthenticated: 2,
          thresholdApiAuthorized: 100,
          thresholdUnauthenticated: 100,
          sampleRate: 0,
          includePathInKey: true,
          includeMethodInKey: true,
        },
      },
    });
    const middleware = createRateLimitAuditMiddleware(providers, config);
    const req = createRequest({
      user: {
        github: {
          id: 123,
        },
      } as any,
      isAuthenticated: vi.fn().mockReturnValue(true) as any,
    });

    await middleware(req, {} as any, vi.fn());
    await middleware(req, {} as any, vi.fn());
    await middleware(req, {} as any, vi.fn());

    expect(req.insights?.trackEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'web.rate_limit.audit.threshold_exceeded',
        properties: expect.objectContaining({
          authTier: 'session_authenticated',
          threshold: '2',
        }),
      })
    );
  });

  it('applies api-authorized threshold when request has an api token', async () => {
    const cacheStore = new Map<string, { count: number }>();
    const cacheProvider = {
      getObject: vi.fn(async (key: string) => cacheStore.get(key)),
      setObjectWithExpire: vi.fn(async (key: string, value: { count: number }) => {
        cacheStore.set(key, value);
      }),
    };
    const providers = {
      cacheProvider,
    } as any;
    const config = createConfiguration({
      rateLimit: {
        mode: 'audit',
        audit: {
          enabled: true,
          windowSeconds: 60,
          threshold: 100,
          thresholdAuthenticated: 100,
          thresholdSessionAuthenticated: 100,
          thresholdApiAuthorized: 2,
          thresholdUnauthenticated: 100,
          sampleRate: 0,
          includePathInKey: true,
          includeMethodInKey: true,
        },
      },
    });
    const middleware = createRateLimitAuditMiddleware(providers, config);
    const req = createRequest({
      user: undefined as any,
      isAuthenticated: vi.fn().mockReturnValue(false) as any,
      apiKeyToken: {
        token: {
          clientId: 'client-a',
          objectId: 'object-a',
        },
        hasAnyScope: vi.fn().mockReturnValue(true),
        getScopes: vi.fn().mockReturnValue(['news']),
      } as any,
    } as any);

    await middleware(req, {} as any, vi.fn());
    await middleware(req, {} as any, vi.fn());
    await middleware(req, {} as any, vi.fn());

    expect(req.insights?.trackEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'web.rate_limit.audit.threshold_exceeded',
        properties: expect.objectContaining({
          authTier: 'api_authorized',
          threshold: '2',
        }),
      })
    );
  });

  it('uses a pre-auth audit tier and never blocks even when config mode is enforce', async () => {
    const cacheStore = new Map<string, { count: number }>();
    const cacheProvider = {
      getObject: vi.fn(async (key: string) => cacheStore.get(key)),
      setObjectWithExpire: vi.fn(async (key: string, value: { count: number }) => {
        cacheStore.set(key, value);
      }),
    };
    const providers = {
      cacheProvider,
    } as any;
    const config = createConfiguration({
      rateLimit: {
        mode: 'enforce',
        audit: {
          enabled: true,
          windowSeconds: 60,
          threshold: 100,
          thresholdAuthenticated: 100,
          thresholdSessionAuthenticated: 100,
          thresholdApiAuthorized: 100,
          thresholdUnauthenticated: 2,
          sampleRate: 0,
          includePathInKey: true,
          includeMethodInKey: true,
        },
      },
    });
    const middleware = createPreAuthRateLimitAuditMiddleware(providers, config);
    const req = createRequest({
      isAuthenticated: vi.fn().mockReturnValue(false) as any,
      apiKeyToken: {
        token: {
          clientId: 'client-a',
          objectId: 'object-a',
        },
        hasAnyScope: vi.fn().mockReturnValue(true),
      } as any,
    } as any);
    const res = createResponse();
    const nextA = vi.fn();
    const nextB = vi.fn();
    const nextC = vi.fn();

    await middleware(req, res, nextA);
    await middleware(req, res, nextB);
    await middleware(req, res, nextC);

    expect(res.setHeader).not.toHaveBeenCalled();
    expect(nextA).toHaveBeenCalledWith();
    expect(nextB).toHaveBeenCalledWith();
    expect(nextC).toHaveBeenCalledWith();
    expect(req.insights?.trackEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'web.rate_limit.pre_auth.audit.threshold_exceeded',
        properties: expect.objectContaining({
          authTier: 'unauthenticated',
          requestPhase: 'pre_auth',
          threshold: '2',
        }),
      })
    );
  });

  it('ignores raw x-forwarded-for spoofing when resolving the pre-auth identity', async () => {
    const cacheStore = new Map<string, { count: number }>();
    const cacheProvider = {
      getObject: vi.fn(async (key: string) => cacheStore.get(key)),
      setObjectWithExpire: vi.fn(async (key: string, value: { count: number }) => {
        cacheStore.set(key, value);
      }),
    };
    const providers = {
      cacheProvider,
    } as any;
    const config = createConfiguration({
      rateLimit: {
        mode: 'audit',
        audit: {
          enabled: true,
          windowSeconds: 60,
          threshold: 100,
          thresholdAuthenticated: 100,
          thresholdSessionAuthenticated: 100,
          thresholdApiAuthorized: 100,
          thresholdUnauthenticated: 1,
          sampleRate: 0,
          includePathInKey: true,
          includeMethodInKey: true,
        },
      },
    });
    const middleware = createPreAuthRateLimitAuditMiddleware(providers, config);
    const reqA = createRequest({
      ip: '10.0.0.1',
      header: vi.fn((name: string) => (name === 'x-forwarded-for' ? '198.51.100.1' : undefined)),
      isAuthenticated: vi.fn().mockReturnValue(false) as any,
    });
    const reqB = createRequest({
      ip: '10.0.0.1',
      header: vi.fn((name: string) => (name === 'x-forwarded-for' ? '203.0.113.9' : undefined)),
      isAuthenticated: vi.fn().mockReturnValue(false) as any,
    });

    await middleware(reqA, {} as any, vi.fn());
    await middleware(reqB, {} as any, vi.fn());

    expect(reqB.insights?.trackEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'web.rate_limit.pre_auth.audit.threshold_exceeded',
        properties: expect.objectContaining({
          authTier: 'unauthenticated',
          observedCount: '2',
        }),
      })
    );
  });
});
