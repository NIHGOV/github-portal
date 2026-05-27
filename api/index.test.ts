//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { describe, expect, it } from 'vitest';

import { CLIENT_ROUTE_PREFIX, isClientRoute, skipApiVersionCheck } from './index.js';

import type { ReposAppRequest } from '../interfaces/index.js';

function fakeRequest(path: string): ReposAppRequest {
  return { path } as unknown as ReposAppRequest;
}

describe('CLIENT_ROUTE_PREFIX', () => {
  it('should be /client', () => {
    expect(CLIENT_ROUTE_PREFIX).toBe('/client');
  });
});

describe('isClientRoute', () => {
  it('returns true for the exact /client path', () => {
    expect(isClientRoute(fakeRequest('/client'))).toBe(true);
  });

  it('returns true for a nested client path', () => {
    expect(isClientRoute(fakeRequest('/client/foo/bar'))).toBe(true);
  });

  it('returns false for a non-client path', () => {
    expect(isClientRoute(fakeRequest('/people'))).toBe(false);
  });

  it('returns false for a path that contains client but does not start with /client', () => {
    expect(isClientRoute(fakeRequest('/api/client'))).toBe(false);
  });

  it('returns false for the root path', () => {
    expect(isClientRoute(fakeRequest('/'))).toBe(false);
  });
});

describe('skipApiVersionCheck', () => {
  it('returns true when the path matches a prefix', () => {
    expect(skipApiVersionCheck(fakeRequest('/client/news'), ['/client'])).toBe(true);
  });

  it('returns true when the path matches the second prefix', () => {
    expect(skipApiVersionCheck(fakeRequest('/special/endpoint'), ['/client', '/special'])).toBe(true);
  });

  it('returns false when the path matches no prefixes', () => {
    expect(skipApiVersionCheck(fakeRequest('/people'), ['/client', '/special'])).toBe(false);
  });

  it('returns false when the prefix list is empty', () => {
    expect(skipApiVersionCheck(fakeRequest('/client/news'), [])).toBe(false);
  });

  it('requires the prefix to be at the start of the path', () => {
    expect(skipApiVersionCheck(fakeRequest('/api/client'), ['/client'])).toBe(false);
  });
});
