//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { describe, expect, test } from 'vitest';
import axios from 'axios';

import {
  installConsoleRedaction,
  installDebugRedaction,
  isApiRequest,
  sanitizeForLogging,
  scrubErrorForLogging,
  storeReferrer,
  stringParam,
} from './utils.js';
import { CreateError } from './transitional.js';

// Axios errors embed the full request config — including every request header —
// inside the error object. scrubErrorForLogging uses an allowlist so that only
// safe, non-sensitive headers survive in error objects before they reach any
// logging or telemetry path.

describe('scrubErrorForLogging — AxiosError resilience', () => {
  // Builds an AxiosError whose config.headers include sensitive values
  // (authorization, shared secrets) alongside safe diagnostic headers.
  function createAxiosErrorWithSensitiveHeaders() {
    return new axios.AxiosError('timeout of 5000ms exceeded', 'ECONNABORTED', {
      url: 'https://mise-sidecar.example.com/ValidateRequest',
      method: 'post',
      timeout: 5000,
      headers: new axios.AxiosHeaders({
        authorization:
          'Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJhcGk6Ly9vc3BvIn0.FAKE_SIGNATURE',
        'x-forwarded-for': '10.0.0.1',
        'original-method': 'GET',
        'original-uri': '/api/people/links',
        'Content-Type': 'application/json',
        'Return-Subject-Token-Claim-oid': '1',
        'Return-Subject-Token-Claim-tid': '1',
        'Return-Subject-Token-Claim-aud': '1',
        'Return-Subject-Token-Claim-appid': '1',
        'Return-Subject-Token-Claim-exp': '1',
        MISE_INTERIM_EXPECTED_SHARED_HEADER: 'some-shared-secret-value',
      }),
    } as any);
  }

  test('sensitive headers are present in raw AxiosError before scrubbing', () => {
    const error = createAxiosErrorWithSensitiveHeaders();
    // Before scrubbing, secrets are embedded in the error object.
    const serialized = JSON.stringify(error);
    expect(serialized).toContain('Bearer eyJ');
    expect(serialized).toContain('FAKE_SIGNATURE');
  });

  test('sensitive headers are removed after scrubErrorForLogging', () => {
    const error = createAxiosErrorWithSensitiveHeaders();
    scrubErrorForLogging(error);

    // After scrubbing, no trace of sensitive values remains anywhere in
    // the serialized error object.
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain('Bearer eyJ');
    expect(serialized).not.toContain('FAKE_SIGNATURE');
    expect(serialized).not.toContain('some-shared-secret-value');
  });

  test('non-standard secret headers are removed after scrubbing', () => {
    const error = createAxiosErrorWithSensitiveHeaders();
    scrubErrorForLogging(error);

    // Custom secret headers not in the allowlist are also removed.
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain('MISE_INTERIM_EXPECTED_SHARED_HEADER');
    expect(serialized).not.toContain('some-shared-secret-value');
  });

  test('diagnostic fields survive scrubbing', () => {
    const error = createAxiosErrorWithSensitiveHeaders();
    scrubErrorForLogging(error);

    // Error message, status, etc. are still available for diagnostics.
    expect(error.message).toBe('timeout of 5000ms exceeded');
    expect(error.code).toBe('ECONNABORTED');
  });

  test('console.dir of scrubbed error does not contain sensitive values', () => {
    const error = createAxiosErrorWithSensitiveHeaders();
    scrubErrorForLogging(error);

    // Capture what console.dir would output.
    const output: string[] = [];
    const origDir = console.dir;
    console.dir = (obj: unknown) => {
      output.push(JSON.stringify(obj, null, 2));
    };
    try {
      console.dir(error);
    } finally {
      console.dir = origDir;
    }

    const logged = output.join('\n');
    expect(logged).not.toContain('Bearer eyJ');
    expect(logged).not.toContain('FAKE_SIGNATURE');
    expect(logged).not.toContain('some-shared-secret-value');
  });
});

describe('scrubErrorForLogging', () => {
  test('removes non-allowlisted headers from error config', () => {
    const error = {
      message: 'Request failed',
      config: {
        headers: {
          Authorization: 'Bearer eyJhbGciOiJSUzI...',
          'Content-Type': 'application/json',
          'x-custom-secret': 'should-be-removed',
        },
      },
    };
    scrubErrorForLogging(error);
    expect(error.config.headers['Authorization']).toBeUndefined();
    expect(error.config.headers['x-custom-secret']).toBeUndefined();
    expect(error.config.headers['Content-Type']).toBe('application/json');
  });

  test('preserves allowlisted headers', () => {
    const error = {
      config: {
        headers: {
          'content-type': 'application/json',
          'x-github-request-id': 'abc-123',
          'x-ratelimit-remaining': '42',
          'retry-after': '30',
          'www-authenticate': 'Bearer realm="test"',
          authorization: 'Bearer secret',
        },
      },
    };
    scrubErrorForLogging(error);
    expect(error.config.headers['content-type']).toBe('application/json');
    expect(error.config.headers['x-github-request-id']).toBe('abc-123');
    expect(error.config.headers['x-ratelimit-remaining']).toBe('42');
    expect(error.config.headers['retry-after']).toBe('30');
    expect(error.config.headers['www-authenticate']).toBe('Bearer realm="test"');
    expect(error.config.headers['authorization']).toBeUndefined();
  });

  test('removes cookie and set-cookie headers', () => {
    const error = {
      config: {
        headers: {
          Cookie: 'session=abc123',
          'Set-Cookie': 'sid=xyz',
          'Content-Type': 'text/html',
        },
      },
    };
    scrubErrorForLogging(error);
    expect(error.config.headers['Cookie']).toBeUndefined();
    expect(error.config.headers['Set-Cookie']).toBeUndefined();
    expect(error.config.headers['Content-Type']).toBe('text/html');
  });

  test('removes non-allowlisted headers from request.headers', () => {
    const error = {
      request: {
        headers: {
          Authorization: 'Bearer secret',
          'content-type': 'application/json',
        },
      },
    };
    scrubErrorForLogging(error);
    expect(error.request.headers['Authorization']).toBeUndefined();
    expect(error.request.headers['content-type']).toBe('application/json');
  });

  test('filters request._header string to only allowlisted headers', () => {
    const error = {
      request: {
        _header:
          'POST /api HTTP/1.1\r\nAuthorization: Bearer eyJ...\r\nContent-Type: application/json\r\nX-Custom: secret\r\n',
      },
    };
    scrubErrorForLogging(error);
    expect(error.request._header).not.toContain('Bearer');
    expect(error.request._header).not.toContain('X-Custom');
    expect(error.request._header).toContain('Content-Type: application/json');
    expect(error.request._header).toContain('POST /api HTTP/1.1');
  });

  test('removes non-allowlisted headers from response.request', () => {
    const error = {
      response: {
        request: {
          headers: {
            Authorization: 'Bearer secret',
            'x-ratelimit-used': '5',
          },
        },
      },
    };
    scrubErrorForLogging(error);
    expect(error.response.request.headers['Authorization']).toBeUndefined();
    expect(error.response.request.headers['x-ratelimit-used']).toBe('5');
  });

  test('handles null/undefined gracefully', () => {
    expect(() => scrubErrorForLogging(null)).not.toThrow();
    expect(() => scrubErrorForLogging(undefined)).not.toThrow();
    expect(() => scrubErrorForLogging('string error')).not.toThrow();
    expect(() => scrubErrorForLogging(42)).not.toThrow();
  });

  test('handles error with no config or request', () => {
    const error = new Error('plain error');
    expect(() => scrubErrorForLogging(error)).not.toThrow();
  });

  test('handles error with empty headers', () => {
    const error = {
      config: { headers: {} },
      request: { headers: {} },
    };
    expect(() => scrubErrorForLogging(error)).not.toThrow();
  });

  test('returns the same error object', () => {
    const error = { message: 'test' };
    const result = scrubErrorForLogging(error);
    expect(result).toBe(error);
  });

  test('removes unknown future headers automatically', () => {
    const error = {
      config: {
        headers: {
          'x-new-secret-header': 'should-be-removed',
          'x-internal-token': 'should-be-removed',
          'content-type': 'application/json',
        },
      },
    };
    scrubErrorForLogging(error);
    expect(error.config.headers['x-new-secret-header']).toBeUndefined();
    expect(error.config.headers['x-internal-token']).toBeUndefined();
    expect(error.config.headers['content-type']).toBe('application/json');
  });

  test('scrubs headers on innerError (wrapped error pattern)', () => {
    const innerError = {
      config: {
        headers: {
          Authorization: 'Bearer secret-token',
          'content-type': 'application/json',
        },
      },
    };
    const outerError = Object.assign(new Error('Wrapper error'), { innerError });
    scrubErrorForLogging(outerError);
    expect(innerError.config.headers['Authorization']).toBeUndefined();
    expect(innerError.config.headers['content-type']).toBe('application/json');
  });

  test('scrubs headers on cause (standard Error cause pattern)', () => {
    const causeError = {
      config: {
        headers: {
          Authorization: 'Bearer secret-token',
          'content-type': 'application/json',
        },
      },
    };
    const outerError = new Error('Wrapper error', { cause: causeError });
    scrubErrorForLogging(outerError);
    expect(causeError.config.headers['Authorization']).toBeUndefined();
    expect(causeError.config.headers['content-type']).toBe('application/json');
  });

  test('scrubs headers on deeply nested innerError chain', () => {
    const deepError = {
      config: {
        headers: {
          Authorization: 'Bearer deep-secret',
          'content-type': 'text/plain',
        },
      },
    };
    const middleError = Object.assign(new Error('Middle'), { innerError: deepError });
    const outerError = Object.assign(new Error('Outer'), { innerError: middleError });
    scrubErrorForLogging(outerError);
    expect(deepError.config.headers['Authorization']).toBeUndefined();
    expect(deepError.config.headers['content-type']).toBe('text/plain');
  });

  test('scrubs headers in AggregateError errors array', () => {
    const nestedError = {
      config: {
        headers: {
          Authorization: 'Bearer aggregate-secret',
          'content-type': 'application/json',
        },
      },
    };
    const aggregate = Object.assign(new Error('Multiple failures'), {
      errors: [nestedError],
    });
    scrubErrorForLogging(aggregate);
    expect(nestedError.config.headers['Authorization']).toBeUndefined();
    expect(nestedError.config.headers['content-type']).toBe('application/json');
  });

  test('handles circular references without infinite recursion', () => {
    const error: any = {
      config: {
        headers: {
          Authorization: 'Bearer circular-secret',
          'content-type': 'application/json',
        },
      },
    };
    error.innerError = error;
    expect(() => scrubErrorForLogging(error)).not.toThrow();
    expect(error.config.headers['Authorization']).toBeUndefined();
    expect(error.config.headers['content-type']).toBe('application/json');
  });

  test('scrubs AxiosError wrapped by CreateError.InvalidParameters (graph provider pattern)', () => {
    const axiosError = new axios.AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST', {
      url: 'https://graph.microsoft.com/v1.0/groups/abc/transitiveMembers',
      method: 'get',
      headers: new axios.AxiosHeaders({
        Authorization: 'Bearer eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.REAL_TOKEN',
        'Accept-Encoding': 'identity',
        'User-Agent': 'axios/1.13.6',
      }),
    } as any);
    const wrappedError = CreateError.InvalidParameters('Incorrect graph parameters', axiosError);
    scrubErrorForLogging(wrappedError);
    const serialized = JSON.stringify(wrappedError);
    expect(serialized).not.toContain('Bearer eyJ');
    expect(serialized).not.toContain('REAL_TOKEN');
    expect(wrappedError.message).toBe('Incorrect graph parameters');
  });
});

describe('sanitizeForLogging', () => {
  test('redacts authorization header strings and bearer tokens', () => {
    const sanitized = sanitizeForLogging('Authorization: Bearer header.payload.signature');

    expect(sanitized).toBe('Authorization: Bearer [REDACTED]');
  });

  test('redacts token query parameters embedded in URLs', () => {
    const sanitized = sanitizeForLogging(
      'https://example.test/callback?access_token=secret-token&id_token=second-secret'
    );

    expect(sanitized).toBe('https://example.test/callback?access_token=[REDACTED]&id_token=[REDACTED]');
  });

  test('preserves bearer realm challenges while redacting bearer tokens', () => {
    const sanitized = sanitizeForLogging(
      'challenge=Bearer realm="example" token=Bearer header.payload.signature'
    );

    expect(sanitized).toBe('challenge=Bearer realm="example" token=Bearer [REDACTED]');
  });

  test('redacts sensitive values in nested objects without mutating the source', () => {
    const original = {
      headers: {
        Authorization: 'Bearer secret-token',
        'content-type': 'application/json',
      },
      request: {
        _header:
          'POST /api HTTP/1.1\r\nAuthorization: Bearer secret-token\r\nContent-Type: application/json\r\n',
      },
      nested: {
        access_token: 'nested-secret',
      },
    };

    const sanitized = sanitizeForLogging(original) as typeof original;

    expect(sanitized.headers.Authorization).toBe('[REDACTED]');
    expect(sanitized.headers['content-type']).toBe('application/json');
    expect(sanitized.request._header).toContain('Authorization: [REDACTED]');
    expect(sanitized.nested.access_token).toBe('[REDACTED]');
    expect(original.headers.Authorization).toBe('Bearer secret-token');
    expect(original.nested.access_token).toBe('nested-secret');
  });
});

describe('installDebugRedaction', () => {
  test('routes debug output through sanitized console logging', () => {
    const output: string[] = [];
    const collector = (...args: unknown[]) => {
      output.push(args.map((arg) => String(arg)).join(' '));
    };

    // Snapshot ALL methods patched by installConsoleRedaction before any modification
    const originalLog = console.log;
    const originalInfo = console.info;
    const originalWarn = console.warn;
    const originalError = console.error;
    const originalDebug = console.debug;
    const originalTrace = console.trace;
    const originalDir = console.dir;
    const consoleRedactionInstalled = Symbol.for('opensource-management-portal.console-redaction');

    console.error = collector;

    try {
      installConsoleRedaction();
      const fakeDebugApi: { log?: (...args: unknown[]) => void } = {};
      installDebugRedaction(fakeDebugApi);
      fakeDebugApi.log?.('Authorization: Bearer header.payload.signature');
    } finally {
      console.log = originalLog;
      console.info = originalInfo;
      console.warn = originalWarn;
      console.error = originalError;
      console.debug = originalDebug;
      console.trace = originalTrace;
      console.dir = originalDir;
      delete (console as unknown as Record<symbol, unknown>)[consoleRedactionInstalled];
    }

    expect(output.join('\n')).toContain('Authorization: Bearer [REDACTED]');
    expect(output.join('\n')).not.toContain('header.payload.signature');
  });
});

describe('stringParam', () => {
  function fakeReq(params: Record<string, string | string[]>) {
    return { params };
  }

  test('returns a plain string param', () => {
    expect(stringParam(fakeReq({ org: 'contoso' }), 'org')).toBe('contoso');
  });

  test('returns empty string for missing param', () => {
    expect(stringParam(fakeReq({}), 'org')).toBe('');
  });

  test('returns the value from a single-element array', () => {
    expect(stringParam(fakeReq({ org: ['contoso'] }), 'org')).toBe('contoso');
  });

  test('throws for a multi-element array', () => {
    expect(() => stringParam(fakeReq({ org: ['a', 'b'] }), 'org')).toThrow(
      'Expected a single string value for param "org", got 2 values'
    );
  });

  test('throws for an empty array', () => {
    expect(() => stringParam(fakeReq({ org: [] }), 'org')).toThrow(
      'Expected a single string value for param "org", got 0 values'
    );
  });
});

describe('isApiRequest', () => {
  function fakeRequest(overrides: Record<string, unknown> = {}) {
    return { url: '/', headers: {}, ...overrides } as any;
  }

  test('returns true when url starts with /api/', () => {
    expect(isApiRequest(fakeRequest({ url: '/api/people' }))).toBe(true);
  });

  test('returns true when apiContext is set', () => {
    expect(isApiRequest(fakeRequest({ apiContext: {} }))).toBe(true);
  });

  test('returns true when Accept header contains application/json', () => {
    expect(isApiRequest(fakeRequest({ headers: { accept: 'application/json' } }))).toBe(true);
  });

  test('returns true when Accept header includes json among others', () => {
    expect(isApiRequest(fakeRequest({ headers: { accept: 'text/html, application/json' } }))).toBe(true);
  });

  test('returns false for a plain browser request', () => {
    expect(isApiRequest(fakeRequest({ url: '/repos', headers: { accept: 'text/html' } }))).toBe(false);
  });

  test('returns false when no relevant signals are present', () => {
    expect(isApiRequest(fakeRequest())).toBe(false);
  });
});

// storeReferrer stores the HTTP Referer header in the session when available,
// then redirects. These tests verify the fix that allows fresh sessions
// (where session.referer is undefined) to store the referrer.

describe('storeReferrer', () => {
  function createFakeReqRes(options: {
    refererHeader?: string;
    sessionReferer?: string | undefined;
    hasSession?: boolean;
  }) {
    const session: Record<string, any> = {};
    if (options.sessionReferer !== undefined) {
      session.referer = options.sessionReferer;
    }
    const req = {
      headers: options.refererHeader ? { referer: options.refererHeader } : {},
      session: options.hasSession === false ? null : session,
      insights: { trackEvent: () => {} },
    } as any;
    let redirectedTo: string | null = null;
    const res = {
      redirect: (url: string) => {
        redirectedTo = url;
      },
    };
    return { req, res, session, getRedirectUrl: () => redirectedTo };
  }

  test('stores HTTP Referer header in session.referer for a fresh session', () => {
    const { req, res, session } = createFakeReqRes({
      refererHeader: 'http://localhost:3000/orgs/myorg/repos/myrepo',
    });
    storeReferrer(req, res, '/auth/entra-id', 'test');
    expect(session.referer).toBe('http://localhost:3000/orgs/myorg/repos/myrepo');
  });

  test('redirects to the specified URL', () => {
    const { req, res, getRedirectUrl } = createFakeReqRes({
      refererHeader: 'http://localhost:3000/some-page',
    });
    storeReferrer(req, res, '/auth/entra-id', 'test');
    expect(getRedirectUrl()).toBe('/auth/entra-id');
  });

  test('does not overwrite an existing non-empty session.referer', () => {
    const { req, res, session } = createFakeReqRes({
      refererHeader: 'http://localhost:3000/new-page',
      sessionReferer: '/existing-page',
    });
    storeReferrer(req, res, '/auth/entra-id', 'test');
    expect(session.referer).toBe('/existing-page');
  });

  test('does not store referer from a signout page', () => {
    const { req, res, session } = createFakeReqRes({
      refererHeader: 'http://localhost:3000/signout/goodbye',
    });
    storeReferrer(req, res, '/auth/entra-id', 'test');
    expect(session.referer).toBeUndefined();
  });

  test('does not store referer when HTTP Referer header is cross-origin', () => {
    const { req, res, session } = createFakeReqRes({
      refererHeader: 'https://evil.example/malicious-path',
    });
    storeReferrer(req, res, '/auth/entra-id', 'test');
    expect(session.referer).toBeUndefined();
  });

  test('does not store referer when no HTTP Referer header is present', () => {
    const { req, res, session } = createFakeReqRes({});
    storeReferrer(req, res, '/auth/entra-id', 'test');
    expect(session.referer).toBeUndefined();
  });

  test('stores referer when session.referer was explicitly set to empty string', () => {
    const { req, res, session } = createFakeReqRes({
      refererHeader: 'http://localhost:3000/some-page',
      sessionReferer: '',
    });
    storeReferrer(req, res, '/auth/entra-id', 'test');
    expect(session.referer).toBe('http://localhost:3000/some-page');
  });
});
