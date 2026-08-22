//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { describe, expect, it, vi } from 'vitest';

import { setStaticAssetHeaders } from './staticHeaders.js';

import type { ServerResponse } from 'http';

describe('setStaticAssetHeaders', () => {
  function makeResponse() {
    return { setHeader: vi.fn() } as unknown as ServerResponse;
  }

  it('sets Content-Type for .svg files', () => {
    const res = makeResponse();
    setStaticAssetHeaders(res, '/assets/logo.svg');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/svg+xml; charset=utf-8');
  });

  it('sets Content-Type for .woff2 files', () => {
    const res = makeResponse();
    setStaticAssetHeaders(res, '/fonts/font.woff2');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'font/woff2');
  });

  it('sets Content-Type for .woff files', () => {
    const res = makeResponse();
    setStaticAssetHeaders(res, '/fonts/font.woff');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'font/woff');
  });

  it('sets Content-Type for .ttf files', () => {
    const res = makeResponse();
    setStaticAssetHeaders(res, '/fonts/font.ttf');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'font/ttf');
  });

  it('does not set Content-Type for unknown extensions', () => {
    const res = makeResponse();
    setStaticAssetHeaders(res, '/assets/script.js');
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('does not set Content-Type when there is no extension', () => {
    const res = makeResponse();
    setStaticAssetHeaders(res, '/assets/readme');
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('handles extension matching case-insensitively', () => {
    const res = makeResponse();
    setStaticAssetHeaders(res, '/assets/logo.SVG');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/svg+xml; charset=utf-8');
  });
});
