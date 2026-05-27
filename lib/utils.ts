//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import fs from 'fs';
import path from 'path';
import { URL, fileURLToPath, pathToFileURL } from 'url';
import zlib from 'zlib';

import type { Response, Request } from 'express';

import { CreateError } from './transitional.js';

import type { Repository } from '../business/repository.js';
import type { ReposAppRequest, IAppSession, IReposError, SiteConfiguration } from '../interfaces/index.js';

const isWindows = process.platform === 'win32';

export function isApiRequest(req: ReposAppRequest | Request): boolean {
  return !!(
    req.url?.startsWith('/api/') || // even in the browser we respond to API endpoints with JSON
    (req as ReposAppRequest).apiContext ||
    (req.headers?.accept && req.headers.accept.includes('application/json'))
  );
}

export function daysInMilliseconds(days: number): number {
  return 1000 * 60 * 60 * 24 * days;
}

export function shortSha(string?: string): string {
  if (!string) {
    return '';
  }
  return string.slice(0, 7);
}

export function importPathSchemeChangeIfWindows(npmName: string) {
  if (isWindows && path.isAbsolute(npmName)) {
    const normalized = path.normalize(npmName);
    const fileUrl = pathToFileURL(normalized);
    return fileUrl.href;
  }
  return npmName;
}

export function dateToDateString(date: Date) {
  return date.toISOString().substr(0, 10);
}

export function stringParam(req: { params: Record<string, string | string[]> }, name: string): string {
  const value = req.params[name];
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new Error(`Expected a single string value for param "${name}", got ${value.length} values`);
    }
    return value[0];
  }
  return value ?? '';
}

export function stringOrNumberAsString(value: any) {
  if (typeof value === 'number') {
    return (value as number).toString();
  } else if (typeof value === 'string') {
    return value;
  }
  const typeName = typeof value;
  throw new Error(`Unsupported type ${typeName} for value ${value} (stringOrNumberAsString)`);
}

export function stringOrNumberArrayAsStringArray(values: any[]) {
  return values.map((val) => stringOrNumberAsString(val));
}

export function requireJson(nameFromRoot: string): any {
  // In some situations TypeScript can load from JSON, but for the transition this is better to reach outside the out directory
  const filename = fileURLToPath(import.meta.url);
  const dirname = path.dirname(filename);
  let file = path.resolve(dirname, nameFromRoot);
  // If within the output directory
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, 'utf8');
    return JSON.parse(content);
  }
  file = path.resolve(dirname, '..', nameFromRoot);
  if (!fs.existsSync(file)) {
    throw new Error(`Cannot find JSON file ${file} to read as a module`);
  }
  const content = fs.readFileSync(file, 'utf8');
  console.warn(`JSON as module (${file}) from project root (NOT TypeScript 'dist' folder)`);
  return JSON.parse(content);
}

export function safeLocalRedirectUrl(path: string) {
  if (!path) {
    return;
  }
  const url = new URL(path, 'http://localhost');
  if (url.host !== 'localhost') {
    return;
  }
  return url.search ? `${url.pathname}${url.search}` : url.pathname;
}

function getRequestOrigin(req: ReposAppRequest): string | undefined {
  const forwardedHost = req.headers?.['x-forwarded-host'];
  const hostHeader = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost || req.headers?.host;
  if (!hostHeader) {
    return;
  }
  const forwardedProto = req.headers?.['x-forwarded-proto'];
  const protocol = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto || req.protocol || 'http';
  return `${protocol}://${hostHeader}`;
}

function getSafeSessionReferer(req: ReposAppRequest): string | undefined {
  const rawReferer = req.headers?.referer;
  if (!rawReferer || rawReferer.includes('/signout')) {
    return;
  }

  let refererUrl: URL;
  try {
    refererUrl = new URL(rawReferer);
  } catch {
    return safeLocalRedirectUrl(rawReferer);
  }

  const requestOrigin = getRequestOrigin(req);
  if (requestOrigin) {
    if (refererUrl.origin !== requestOrigin) {
      return;
    }
    return refererUrl.search ? `${refererUrl.pathname}${refererUrl.search}` : refererUrl.pathname;
  }

  if (refererUrl.hostname === 'localhost' || refererUrl.hostname === '127.0.0.1') {
    return rawReferer;
  }
}

// Session utility: Store the referral URL, if present, and redirect to a new
// location.
interface IStoreReferrerEventDetails {
  method: string;
  reason: string;
  referer?: string;
  redirect?: string;
}

export function storeReferrer(req: ReposAppRequest, res, redirect, optionalReason) {
  const { insights } = req;
  const eventDetails: IStoreReferrerEventDetails = {
    method: 'storeReferrer',
    reason: optionalReason || 'unknown reason',
  };
  const session = req.session as IAppSession;
  const safeReferer = getSafeSessionReferer(req);
  if (session && safeReferer && !session.referer) {
    session.referer = safeReferer;
    eventDetails.referer = safeReferer;
  } else {
    eventDetails.referer = 'no referer';
  }
  if (redirect) {
    eventDetails.redirect = redirect;
    insights?.trackEvent({ name: 'RedirectWithReferrer', properties: eventDetails });
    res.redirect(redirect);
  }
}

export function sortByCaseInsensitive(a: string, b: string) {
  const nameA = a.toLowerCase();
  const nameB = b.toLowerCase();
  if (nameA < nameB) {
    return -1;
  }
  if (nameA > nameB) {
    return 1;
  }
  return 0;
}

export function cleanResponse<T = any>(response: T) {
  if ((response as any)?.cost) {
    delete (response as any).cost;
  }
  if ((response as any)?.headers) {
    delete (response as any).headers;
  }
  return response as Omit<T, 'cost' | 'headers'>;
}

export function sortRepositoriesByNameCaseInsensitive(a: Repository, b: Repository, full_name = false) {
  let nameA, nameB;
  if (full_name) {
    nameA = a.full_name.toLowerCase();
    nameB = b.full_name.toLowerCase();
  } else {
    nameA = a.name.toLowerCase();
    nameB = b.name.toLowerCase();
  }
  if (nameA < nameB) {
    return -1;
  }
  if (nameA > nameB) {
    return 1;
  }
  return 0;
}

// ----------------------------------------------------------------------------
// Session utility: store the original URL
// ----------------------------------------------------------------------------
export function storeOriginalUrlAsReferrer(
  req: ReposAppRequest,
  res: Response,
  redirect: string,
  optionalReason?: string
) {
  storeOriginalUrlAsVariable(req, res, 'referer', redirect, optionalReason);
}

export function redirectToReferrer(req: ReposAppRequest, res: Response, url, optionalReason) {
  const activeContext = req.apiContext || req.individualContext;
  url = url || '/';
  const alternateUrl = popSessionVariable(req, res, 'referer');
  const eventDetails = {
    method: 'redirectToReferrer',
    reason: optionalReason || 'unknown reason',
  };
  activeContext?.insights?.trackEvent({ name: 'RedirectToReferrer', properties: eventDetails });
  res.redirect(alternateUrl || url);
}

export function storeOriginalUrlAsVariable(
  req: ReposAppRequest,
  res: Response,
  variable,
  redirect,
  optionalReason
) {
  const activeContext = req.apiContext || req.individualContext;
  const eventDetails = {
    method: 'storeOriginalUrlAsVariable',
    variable,
    redirect,
    reason: optionalReason || 'unknown reason',
  };
  if (req.session && req.originalUrl) {
    req.session[variable] = req.originalUrl;
    eventDetails['ou'] = req.originalUrl;
  }
  if (redirect) {
    activeContext?.insights?.trackEvent({ name: 'RedirectFromOriginalUrl', properties: eventDetails });
    res.redirect(redirect);
  }
}

export function popSessionVariable(req: ReposAppRequest, res: Response, variableName) {
  if (req.session && req.session[variableName] !== undefined) {
    const url = req.session[variableName];
    delete req.session[variableName];
    return url;
  }
}

// ----------------------------------------------------------------------------
// Provide our own error wrapper and message for an underlying thrown error.
// Useful for the user-presentable version.
// ----------------------------------------------------------------------------
const errorPropertiesToClone = ['stack', 'status'];

export function wrapError(error, message, userIntendedMessage?: boolean): IReposError {
  const err: IReposError = new Error(message, { cause: error });
  if (error) {
    for (let i = 0; i < errorPropertiesToClone.length; i++) {
      const key = errorPropertiesToClone[i];
      const value = error[key];
      if (value && typeof value === 'number') {
        // Store as a string
        err[key] = value.toString();
      } else if (value) {
        err[key] = value;
      }
    }
  }
  if (userIntendedMessage === true) {
    err.skipLog = true;
  }
  return err;
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      process.nextTick(resolve);
    }, milliseconds);
  });
}

export function readFileToText(filename: string): Promise<string> {
  return new Promise((resolve, reject) => {
    return fs.readFile(filename, 'utf8', (error, data) => {
      return error ? reject(error) : resolve(data);
    });
  });
}

export function writeTextToFile(filename: string, stringContent: string): Promise<void> {
  return new Promise((resolve, reject) => {
    return fs.writeFile(filename, stringContent, 'utf8', (error) => {
      if (error) {
        console.warn(`Trouble writing ${filename} ${error}`);
      } else {
        console.log(`Wrote ${filename}`);
      }
      return error ? reject(error) : resolve();
    });
  });
}

export function quitInTenSeconds(successful: boolean, config?: SiteConfiguration) {
  // To allow telemetry to flush, we'll wait typically
  if (config?.debug?.exitImmediately || process.env.EXIT_IMMEDIATELY === '1') {
    console.log(`EXIT_IMMEDIATELY set, exiting... exit code=${successful ? 0 : 1}`);
    return process.exit(successful ? 0 : 1);
  }
  console.log(`Quitting process in 10s... exit code=${successful ? 0 : 1}`);
  return setTimeout(() => {
    process.exit(successful ? 0 : 1);
  }, 1000 * 10 /* 10s */);
}

export function gzipString(value: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const val = Buffer.from(value);
    zlib.gzip(val, (gzipError, compressed: Buffer) => {
      return gzipError ? reject(gzipError) : resolve(compressed);
    });
  });
}

export function gunzipBuffer(buffer: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    zlib.gunzip(buffer, (unzipError, unzipped) => {
      // Fallback if there is a data error (i.e. it's not compressed)
      if (unzipError && (unzipError as any)?.errno === zlib.constants.Z_DATA_ERROR) {
        const originalValue = buffer.toString();
        return resolve(originalValue);
      } else if (unzipError) {
        return reject(unzipError);
      }
      try {
        const unzippedValue = unzipped.toString();
        return resolve(unzippedValue);
      } catch (otherError) {
        return reject(otherError);
      }
    });
  });
}

export function swapMap(map: Map<string, string>): Map<string, string> {
  const rm = new Map<string, string>();
  for (const [key, value] of map.entries()) {
    rm.set(value, key);
  }
  return rm;
}

export function addArrayToSet<T>(set: Set<T>, array: T[]): Set<T> {
  for (const entry of array) {
    set.add(entry);
  }
  return set;
}

export function isEnterpriseManagedUserLogin(login: string) {
  return login?.includes('_');
}

export function isCodespacesAuthenticating(
  config: SiteConfiguration,
  authType: 'aad' | 'github' | 'entra-id'
) {
  const { codespaces } = config?.github || {};
  return (
    codespaces?.connected === true &&
    codespaces?.authentication &&
    codespaces.authentication[authType] &&
    codespaces.authentication[authType].enabled
  );
}

export function getCodespacesHostname(config: SiteConfiguration) {
  const { github, webServer } = config;
  const { codespaces } = github;
  const { connected, desktop } = codespaces;
  let codespacesPort = undefined;
  if (connected === true) {
    codespacesPort = codespaces.authentication?.port;
  }
  const port = codespacesPort || webServer.port || 3000;
  const forwardingDomain = codespaces?.forwardingDomain || 'preview.app.github.dev';
  return desktop ? `http://localhost:${port}` : `https://${codespaces.name}-${port}.${forwardingDomain}`;
}

export function getDateTimeBasedBlobFolder() {
  // Returns a UTC-named folder name like "2020/01/01/00-00-00"
  const now = new Date();
  const timeFilename = `${String(now.getUTCHours()).padEnd(2)}-${String(now.getUTCMinutes()).padStart(
    2,
    '0'
  )}-${String(now.getUTCSeconds()).padStart(2, '0')}`;
  const blobFilename = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${String(
    now.getUTCDate()
  ).padStart(2, '0')}/${timeFilename}`;
  return blobFilename;
}

export const botBracket = '[bot]';

const githubAvatarHostnames = [
  'githubusercontent.com',
  'objects.githubusercontent.com',
  'object.githubusercontent.com',
  'raw.githubusercontent.com',
  'avatars.githubusercontent.com',
];

export function getUserIdFromWellFormedAvatar(avatar: string): string {
  // https://*.githubusercontent.com/u/userid?v=*
  const url = new URL(avatar);
  if (githubAvatarHostnames.includes(url.hostname)) {
    const { pathname } = url;
    const i = pathname.indexOf('/u/');
    if (i >= 0) {
      return pathname.substr(i + 3);
    }
  }
  return null;
}

export function asIso8601DayOnly(value: Date | string) {
  if (typeof value === 'string') {
    value = new Date(value);
  }
  if (value instanceof Date) {
    return value.toISOString().substr(0, 10);
  }
  throw CreateError.InvalidParameters('Invalid date value: ' + value);
}

export function fromIso8601DateToUnderscored(value: Date | string) {
  const str = asIso8601DayOnly(value);
  return str.replaceAll(':', '_');
}

export function stripIso8601Microseconds(value: string) {
  return value.substring(0, value.length - 5);
}

export function fromIso8601DateToUnderscoredWithTime(value: Date | string) {
  value = fromIso8601DateToUnderscored(value);
  return stripIso8601Microseconds(value);
}

// Only headers in this set are preserved when scrubbing error objects for
// logging. Every other header (Authorization, Cookie, custom secrets, etc.)
// is removed automatically so new sensitive headers cannot leak.
const ALLOWED_LOG_HEADERS = new Set([
  'content-type',
  'content-length',
  'etag',
  'last-modified',
  'link',
  'retry-after',
  'x-github-request-id',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-resource',
  'x-ratelimit-used',
  'www-authenticate',
  'error-description',
  'av',
  'x-github-sso',
  'subject-token-claim-aud',
  'subject-token-claim-exp',
  'subject-token-claim-appid',
  'subject-token-claim-oid',
  'subject-token-claim-tid',
]);

const CONSOLE_REDACTION_INSTALLED = Symbol.for('opensource-management-portal.console-redaction');
const DEBUG_REDACTION_INSTALLED = Symbol.for('opensource-management-portal.debug-redaction');
const LOG_REDACTION_PLACEHOLDER = '[REDACTED]';
const SENSITIVE_LOG_FIELDS = new Set([
  'access_token',
  'assertion',
  'authorization',
  'client_secret',
  'cookie',
  'id_token',
  'proxy-authorization',
  'refresh_token',
  'set-cookie',
]);
const SENSITIVE_LOG_PAIR_FIELDS = new Set([
  'access_token',
  'assertion',
  'authorization',
  'client_secret',
  'cookie',
  'id_token',
  'proxy-authorization',
  'refresh_token',
  'set-cookie',
]);
const SENSITIVE_LOG_QUERY_FIELDS = new Set(['access_token', 'id_token', 'refresh_token']);
const BEARER_PREFIX = 'bearer ';

export function scrubErrorForLogging(error: unknown): unknown {
  return scrubErrorRecursive(error, new WeakSet());
}

function scrubErrorRecursive(error: unknown, seen: WeakSet<object>): unknown {
  if (!error || typeof error !== 'object') {
    return error;
  }
  if (seen.has(error as object)) {
    return error;
  }
  seen.add(error as object);
  const axiosLike = error as {
    config?: { headers?: Record<string, unknown> };
    request?: { headers?: Record<string, unknown>; _header?: string };
    response?: { request?: { headers?: Record<string, unknown>; _header?: string } };
  };
  filterToAllowedHeaders(axiosLike?.config?.headers);
  filterToAllowedHeaders(axiosLike?.request?.headers);
  if (typeof axiosLike?.request?._header === 'string') {
    axiosLike.request._header = filterHeaderString(axiosLike.request._header);
  }
  filterToAllowedHeaders(axiosLike?.response?.request?.headers);
  if (typeof axiosLike?.response?.request?._header === 'string') {
    axiosLike.response.request._header = filterHeaderString(axiosLike.response.request._header);
  }
  // Recursively scrub wrapped errors (innerError, cause, AggregateError.errors)
  const errorRecord = error as Record<string, unknown>;
  if (errorRecord.innerError) {
    scrubErrorRecursive(errorRecord.innerError, seen);
  }
  if (errorRecord.cause) {
    scrubErrorRecursive(errorRecord.cause, seen);
  }
  if (Array.isArray(errorRecord.errors)) {
    for (const nested of errorRecord.errors) {
      scrubErrorRecursive(nested, seen);
    }
  }
  return error;
}

function filterToAllowedHeaders(headers: Record<string, unknown> | undefined): void {
  if (!headers || typeof headers !== 'object') {
    return;
  }
  for (const key of Object.keys(headers)) {
    if (!ALLOWED_LOG_HEADERS.has(key.toLowerCase())) {
      delete headers[key];
    }
  }
}

function filterHeaderString(raw: string): string {
  return raw
    .split('\r\n')
    .filter((line) => {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) {
        return true;
      }
      const name = line.substring(0, colonIndex).trim().toLowerCase();
      return ALLOWED_LOG_HEADERS.has(name);
    })
    .join('\r\n');
}

export function sanitizeForLogging(value: unknown): unknown {
  return sanitizeForLoggingRecursive(value, new WeakMap());
}

export function installConsoleRedaction(): void {
  const patchedConsole = console as typeof console & { [CONSOLE_REDACTION_INSTALLED]?: boolean };
  if (patchedConsole[CONSOLE_REDACTION_INSTALLED]) {
    return;
  }

  const originalLog = console.log.bind(console);
  const originalInfo = console.info.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  const originalDebug = console.debug.bind(console);
  const originalTrace = console.trace.bind(console);
  const originalDir = console.dir.bind(console);

  console.log = (...args: unknown[]) => originalLog(...args.map(sanitizeForLogging));
  console.info = (...args: unknown[]) => originalInfo(...args.map(sanitizeForLogging));
  console.warn = (...args: unknown[]) => originalWarn(...args.map(sanitizeForLogging));
  console.error = (...args: unknown[]) => originalError(...args.map(sanitizeForLogging));
  console.debug = (...args: unknown[]) => originalDebug(...args.map(sanitizeForLogging));
  console.trace = (...args: unknown[]) => originalTrace(...args.map(sanitizeForLogging));
  console.dir = (item?: unknown, options?: unknown) => originalDir(sanitizeForLogging(item), options);

  patchedConsole[CONSOLE_REDACTION_INSTALLED] = true;
}

export function installDebugRedaction(debugApi: {
  log?: (...args: unknown[]) => void;
  [DEBUG_REDACTION_INSTALLED]?: boolean;
}): void {
  if (debugApi[DEBUG_REDACTION_INSTALLED]) {
    return;
  }

  debugApi.log = (...args: unknown[]) => {
    console.error(...args.map(sanitizeForLogging));
  };
  debugApi[DEBUG_REDACTION_INSTALLED] = true;
}

function sanitizeForLoggingRecursive(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') {
    return redactSensitiveLogString(value);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date) {
    return value;
  }
  if (value instanceof URL) {
    return redactSensitiveLogString(value.toString());
  }

  const cached = seen.get(value as object);
  if (cached) {
    return cached;
  }

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const nested of value) {
      clone.push(sanitizeForLoggingRecursive(nested, seen));
    }
    return clone;
  }

  if (value instanceof Error) {
    return sanitizeErrorForLogging(value, seen);
  }

  const clone: Record<string, unknown> = {};
  seen.set(value as object, clone);
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    clone[key] = sanitizeForLoggingProperty(key, nested, seen);
  }
  return clone;
}

function sanitizeErrorForLogging(error: Error, seen: WeakMap<object, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {
    name: error.name,
    message: redactSensitiveLogString(error.message),
  };
  seen.set(error, clone);
  if (error.stack) {
    clone.stack = redactSensitiveLogString(error.stack);
  }
  for (const [key, nested] of Object.entries(error as unknown as Record<string, unknown>)) {
    clone[key] = sanitizeForLoggingProperty(key, nested, seen);
  }
  scrubErrorForLogging(clone);
  return clone;
}

function sanitizeForLoggingProperty(key: string, value: unknown, seen: WeakMap<object, unknown>): unknown {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey === '_header' && typeof value === 'string') {
    return redactHeaderString(value);
  }
  if (normalizedKey === 'headers' && value && typeof value === 'object') {
    return sanitizeHeadersForLogging(value as Record<string, unknown>, seen);
  }
  if (SENSITIVE_LOG_FIELDS.has(normalizedKey)) {
    return LOG_REDACTION_PLACEHOLDER;
  }
  return sanitizeForLoggingRecursive(value, seen);
}

function sanitizeHeadersForLogging(
  headers: Record<string, unknown>,
  seen: WeakMap<object, unknown>
): Record<string, unknown> {
  const cached = seen.get(headers);
  if (cached && typeof cached === 'object' && !Array.isArray(cached)) {
    return cached as Record<string, unknown>;
  }

  const clone: Record<string, unknown> = {};
  seen.set(headers, clone);
  for (const [key, value] of Object.entries(headers)) {
    if (ALLOWED_LOG_HEADERS.has(key.toLowerCase())) {
      clone[key] = sanitizeForLoggingRecursive(value, seen);
    } else {
      clone[key] = LOG_REDACTION_PLACEHOLDER;
    }
  }
  return clone;
}

function redactHeaderString(raw: string): string {
  return raw
    .split('\r\n')
    .map((line) => {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) {
        return redactSensitiveLogString(line);
      }
      const name = line.substring(0, colonIndex).trim();
      if (ALLOWED_LOG_HEADERS.has(name.toLowerCase())) {
        return `${name}:${redactSensitiveLogString(line.substring(colonIndex + 1))}`;
      }
      return `${name}: ${LOG_REDACTION_PLACEHOLDER}`;
    })
    .join('\r\n');
}

function redactSensitiveLogString(value: string): string {
  let redacted = value;
  for (const field of SENSITIVE_LOG_PAIR_FIELDS) {
    redacted = redactNamedValue(redacted, field);
  }
  for (const field of SENSITIVE_LOG_QUERY_FIELDS) {
    redacted = redactQueryParameter(redacted, field);
  }
  return redactStandaloneBearerTokens(redacted);
}

function redactNamedValue(raw: string, field: string): string {
  const lower = raw.toLowerCase();
  const fieldLower = field.toLowerCase();
  let result = '';
  let start = 0;

  while (start < raw.length) {
    const match = lower.indexOf(fieldLower, start);
    if (match === -1) {
      result += raw.substring(start);
      break;
    }
    if (!isWordBoundary(raw, match - 1) || !isWordBoundary(raw, match + field.length)) {
      result += raw.substring(start, match + field.length);
      start = match + field.length;
      continue;
    }

    let cursor = match + field.length;
    if (raw[cursor] === '"' || raw[cursor] === "'") {
      cursor++;
    }
    cursor = skipWhitespace(raw, cursor);
    if (raw[cursor] !== ':' && raw[cursor] !== '=') {
      result += raw.substring(start, match + field.length);
      start = match + field.length;
      continue;
    }

    cursor++;
    cursor = skipWhitespace(raw, cursor);
    const openingQuote = raw[cursor] === '"' || raw[cursor] === "'" ? raw[cursor] : '';
    if (openingQuote) {
      cursor++;
    }

    let replacementPrefix = raw.substring(match, cursor);
    let valueStart = cursor;
    if (
      (fieldLower === 'authorization' || fieldLower === 'proxy-authorization') &&
      raw.substring(valueStart, valueStart + BEARER_PREFIX.length).toLowerCase() === BEARER_PREFIX
    ) {
      replacementPrefix += raw.substring(valueStart, valueStart + BEARER_PREFIX.length);
      valueStart += BEARER_PREFIX.length;
    }

    const valueEnd = findValueEnd(raw, valueStart);
    result += raw.substring(start, match);
    result += replacementPrefix;
    result += LOG_REDACTION_PLACEHOLDER;
    if (openingQuote && raw[valueEnd] === openingQuote) {
      result += openingQuote;
      start = valueEnd + 1;
    } else {
      start = valueEnd;
    }
  }

  return result;
}

function redactQueryParameter(raw: string, field: string): string {
  const lower = raw.toLowerCase();
  const needle = `${field.toLowerCase()}=`;
  let result = '';
  let start = 0;

  while (start < raw.length) {
    const match = lower.indexOf(needle, start);
    if (match === -1) {
      result += raw.substring(start);
      break;
    }
    const prefixChar = raw[match - 1];
    if (prefixChar !== '?' && prefixChar !== '&') {
      result += raw.substring(start, match + needle.length);
      start = match + needle.length;
      continue;
    }

    const valueStart = match + needle.length;
    const valueEnd = findQueryValueEnd(raw, valueStart);
    result += raw.substring(start, valueStart);
    result += LOG_REDACTION_PLACEHOLDER;
    start = valueEnd;
  }

  return result;
}

function redactStandaloneBearerTokens(raw: string): string {
  const lower = raw.toLowerCase();
  let result = '';
  let start = 0;

  while (start < raw.length) {
    const match = lower.indexOf(BEARER_PREFIX, start);
    if (match === -1) {
      result += raw.substring(start);
      break;
    }
    if (!isWordBoundary(raw, match - 1)) {
      result += raw.substring(start, match + BEARER_PREFIX.length);
      start = match + BEARER_PREFIX.length;
      continue;
    }

    const valueStart = match + BEARER_PREFIX.length;
    if (raw.substring(valueStart, valueStart + 6).toLowerCase() === 'realm=') {
      result += raw.substring(start, valueStart);
      start = valueStart;
      continue;
    }

    const valueEnd = findBearerTokenEnd(raw, valueStart);
    const token = raw.substring(valueStart, valueEnd);
    if (!looksLikeBearerToken(token)) {
      result += raw.substring(start, valueStart);
      start = valueStart;
      continue;
    }

    result += raw.substring(start, valueStart);
    result += LOG_REDACTION_PLACEHOLDER;
    start = valueEnd;
  }

  return result;
}

function skipWhitespace(raw: string, start: number): number {
  let cursor = start;
  while (cursor < raw.length && isWhitespace(raw[cursor])) {
    cursor++;
  }
  return cursor;
}

function findValueEnd(raw: string, start: number): number {
  let cursor = start;
  while (cursor < raw.length && !isGenericValueTerminator(raw[cursor])) {
    cursor++;
  }
  return cursor;
}

function findQueryValueEnd(raw: string, start: number): number {
  let cursor = start;
  while (cursor < raw.length && !isQueryValueTerminator(raw[cursor])) {
    cursor++;
  }
  return cursor;
}

function findBearerTokenEnd(raw: string, start: number): number {
  let cursor = start;
  while (cursor < raw.length && isBearerTokenCharacter(raw[cursor])) {
    cursor++;
  }
  return cursor;
}

function looksLikeBearerToken(value: string): boolean {
  if (!value) {
    return false;
  }
  if (value.length >= 20) {
    return true;
  }
  const segments = value.split('.');
  return (
    (segments.length === 2 || segments.length === 3) &&
    segments.every((segment) => segment.length > 0 && isBearerTokenSegment(segment))
  );
}

function isBearerTokenSegment(value: string): boolean {
  for (const char of value) {
    if (!isBearerTokenCharacter(char)) {
      return false;
    }
  }
  return true;
}

function isBearerTokenCharacter(char: string | undefined): boolean {
  return !!char && 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~+/='.includes(char);
}

function isGenericValueTerminator(char: string | undefined): boolean {
  return (
    !char ||
    char === '"' ||
    char === "'" ||
    char === ',' ||
    char === '\r' ||
    char === '\n' ||
    char === '}' ||
    char === '&'
  );
}

function isQueryValueTerminator(char: string | undefined): boolean {
  return !char || char === '&' || isWhitespace(char);
}

function isWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n';
}

function isWordBoundary(raw: string, index: number): boolean {
  if (index < 0 || index >= raw.length) {
    return true;
  }
  const char = raw[index];
  return !isAsciiLetter(char) && !isAsciiDigit(char) && char !== '_' && char !== '-';
}

function isAsciiLetter(char: string | undefined): boolean {
  if (!char) {
    return false;
  }
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(char: string | undefined): boolean {
  if (!char) {
    return false;
  }
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
}
