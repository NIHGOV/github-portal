//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import type { IAppSession } from '../interfaces/index.js';

const REDACTED = '*****';

interface IRequestUser {
  lastAuthenticated?: string;
  github?: Record<string, unknown>;
  githubIncreasedScope?: Record<string, unknown>;
  azure?: Record<string, unknown>;
}

function redactKeys(source: Record<string, unknown>, sensitiveKeys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key in source) {
    result[key] = sensitiveKeys.includes(key) ? REDACTED : source[key];
  }
  return result;
}

export function collectSessionDiagnostics(
  session: IAppSession,
  user: IRequestUser | undefined
): Record<string, unknown> {
  const diagnostics: Record<string, unknown> = {};
  if (user?.lastAuthenticated) {
    diagnostics.lastAuthenticated = user.lastAuthenticated;
  }
  if (user?.github) {
    diagnostics.github = redactKeys(user.github, ['accessToken']);
  }
  if (user?.githubIncreasedScope || (user?.github && user.github['scope'] === 'githubapp')) {
    const source =
      user.github && user.github['scope'] === 'githubapp' ? user.github : user.githubIncreasedScope;
    diagnostics.githubIncreasedScope = redactKeys(source as Record<string, unknown>, ['accessToken']);
  }
  if (user?.azure) {
    diagnostics.azure = redactKeys(user.azure, ['accessToken', 'oauthToken']);
  }
  const sessionScalars: Record<string, unknown> = {};
  for (const key in session) {
    if (key === 'id' || typeof session[key] === 'object') {
      continue;
    }
    sessionScalars[key] = session[key];
  }
  diagnostics.session = sessionScalars;
  diagnostics.sessionFlags = session.sessionFlags || [];
  return diagnostics;
}
