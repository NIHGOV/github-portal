//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { describe, expect, it, vi } from 'vitest';

import securityHeaders from './securityHeaders.js';

describe('securityHeaders', () => {
  it('sets defensive headers including content security policy', () => {
    const req = {} as Parameters<typeof securityHeaders>[0];
    const res = {
      setHeader: vi.fn(),
    } as unknown as Parameters<typeof securityHeaders>[1];
    const next = vi.fn();

    securityHeaders(req, res, next);

    // @cspell: ignore nosniff SAMEORIGIN
    expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
    expect(res.setHeader).toHaveBeenCalledWith('X-Frame-Options', 'SAMEORIGIN');
    expect(next).toHaveBeenCalledOnce();
  });
});
