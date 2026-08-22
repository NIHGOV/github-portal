//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import * as path from 'path';
import type { ServerResponse } from 'http';

const CONTENT_TYPE_OVERRIDES: Record<string, string> = {
  '.svg': 'image/svg+xml; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

export function setStaticAssetHeaders(res: ServerResponse, filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPE_OVERRIDES[ext];
  if (contentType) {
    res.setHeader('Content-Type', contentType);
  }
}
