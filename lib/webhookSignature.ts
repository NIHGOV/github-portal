//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import crypto from 'crypto';
import { CreateError } from './transitional.js';

const SHA256_PREFIX = 'sha256=';

export type WebhookRawBody = string | Buffer;

export type WebhookSignatureOutcome = 'valid' | 'invalid' | 'missing';

export type WebhookSignatureResult =
  | { outcome: 'missing'; proceed: boolean }
  | { outcome: 'valid'; proceed: true }
  | { outcome: 'invalid'; proceed: boolean; received: string };

export interface ValidateWebhookSignatureOptions {
  signature: string | undefined;
  rawBody: string;
  secret: string | undefined;
  // Allow events with invalid or missing signatures to proceed (audit mode).
  allowInvalidSignature: boolean;
  // Forks of official repos may send events without signatures, skip them.
  acceptUnsigned: boolean;
}

export function requireWebhookRawBody(body: unknown, source: string): WebhookRawBody {
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    return body;
  }

  if (body === undefined || body === null) {
    throw CreateError.InvalidParameters(`Missing ${source} for webhook raw body processing`);
  }

  throw CreateError.InvalidParameters(`Unsupported ${source} type for webhook raw body processing`);
}

export function normalizeWebhookRawBody(body: WebhookRawBody): string {
  if (typeof body === 'string') {
    return body;
  }
  if (Buffer.isBuffer(body)) {
    return body.toString('utf8');
  }

  throw CreateError.InvalidParameters('Unsupported webhook raw body type');
}

export function verifyHmac256(rawBody: string, signature: string, secret: string): boolean {
  const hex = signature.startsWith(SHA256_PREFIX) ? signature.slice(SHA256_PREFIX.length) : signature;
  const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hex, 'hex'));
  } catch {
    return false;
  }
}

export function validateWebhookSignature(options: ValidateWebhookSignatureOptions): WebhookSignatureResult {
  const { signature, rawBody, secret, allowInvalidSignature, acceptUnsigned } = options;
  if (!signature) {
    return { outcome: 'missing', proceed: allowInvalidSignature || acceptUnsigned };
  }
  if (!secret) {
    return { outcome: 'missing', proceed: allowInvalidSignature || acceptUnsigned };
  }
  const receivedHash = signature.startsWith(SHA256_PREFIX)
    ? signature.slice(SHA256_PREFIX.length)
    : signature;
  const computedHash = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    const hashesMatch =
      receivedHash.length === computedHash.length &&
      crypto.timingSafeEqual(Buffer.from(receivedHash), Buffer.from(computedHash));
    if (hashesMatch) {
      return { outcome: 'valid', proceed: true };
    }
  } catch {
    // timingSafeEqual throws if buffer lengths differ
  }
  return {
    outcome: 'invalid',
    proceed: allowInvalidSignature,
    received: signature,
  };
}
