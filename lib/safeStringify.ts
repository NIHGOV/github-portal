//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

export function safeStringify(value: unknown, fallback = '[unserializable]'): string {
  try {
    const result = JSON.stringify(value);
    return result === undefined ? fallback : result;
  } catch {
    return fallback;
  }
}
