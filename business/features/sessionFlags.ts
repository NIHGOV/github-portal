//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

export enum SessionFlag {
  NegatePortalAdmin = 'negate_portal_admin',
}

export const ALLOWED_SESSION_FLAGS = new Set<string>(Object.values(SessionFlag));

export function validateSessionFlag(flag: string): SessionFlag | null {
  if (!flag || typeof flag !== 'string') {
    return null;
  }
  const trimmed = flag.trim().toLowerCase();
  if (!ALLOWED_SESSION_FLAGS.has(trimmed)) {
    return null;
  }
  return trimmed as SessionFlag;
}
