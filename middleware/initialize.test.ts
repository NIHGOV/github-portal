//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { describe, expect, it } from 'vitest';

import { shouldPrepareSessionMiddleware } from './initialize.js';

describe('shouldPrepareSessionMiddleware', () => {
  it('returns false for non-web job profile', () => {
    const applicationProfile = {
      applicationName: 'job profile',
      logDependencies: true,
      serveClientAssets: false,
      serveStaticAssets: false,
      sessions: true,
      webServer: false,
    };

    expect(shouldPrepareSessionMiddleware(applicationProfile)).toBe(false);
  });

  it('returns true when sessions and web server are enabled', () => {
    const applicationProfile = {
      applicationName: 'web profile',
      logDependencies: true,
      serveClientAssets: true,
      serveStaticAssets: true,
      sessions: true,
      webServer: true,
    };

    expect(shouldPrepareSessionMiddleware(applicationProfile)).toBe(true);
  });

  it('returns false when sessions are disabled', () => {
    const applicationProfile = {
      applicationName: 'web without sessions',
      logDependencies: true,
      serveClientAssets: true,
      serveStaticAssets: true,
      sessions: false,
      webServer: true,
    };

    expect(shouldPrepareSessionMiddleware(applicationProfile)).toBe(false);
  });
});
