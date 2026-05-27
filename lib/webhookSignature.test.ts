//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import crypto from 'crypto';
import { describe, expect, it } from 'vitest';

import {
  normalizeWebhookRawBody,
  requireWebhookRawBody,
  validateWebhookSignature,
  verifyHmac256,
} from './webhookSignature.js';

const SECRET = 'test-webhook-secret';
const BODY = '{"action":"opened","repository":{"full_name":"org/repo"}}';

function sign(body: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('normalizeWebhookRawBody', () => {
  it('returns strings unchanged', () => {
    expect(normalizeWebhookRawBody(BODY)).toBe(BODY);
  });

  it('converts buffers to utf8 strings', () => {
    expect(normalizeWebhookRawBody(Buffer.from(BODY, 'utf8'))).toBe(BODY);
  });
});

describe('requireWebhookRawBody', () => {
  it('accepts strings unchanged', () => {
    expect(requireWebhookRawBody(BODY, 'test body')).toBe(BODY);
  });

  it('accepts Buffer values', () => {
    const buf = Buffer.from(BODY, 'utf8');
    expect(requireWebhookRawBody(buf, 'test body')).toBe(buf);
  });

  it('rejects undefined with a missing error', () => {
    expect(() => requireWebhookRawBody(undefined, 'test body')).toThrow(
      'Missing test body for webhook raw body processing'
    );
  });

  it('rejects null with a missing error', () => {
    expect(() => requireWebhookRawBody(null, 'test body')).toThrow(
      'Missing test body for webhook raw body processing'
    );
  });

  it('rejects unsupported body types with an unsupported error', () => {
    expect(() => requireWebhookRawBody(JSON.parse(BODY), 'test body')).toThrow(
      'Unsupported test body type for webhook raw body processing'
    );
  });
});

// -- verifyHmac256 --

describe('verifyHmac256', () => {
  it('returns true for a valid signature with sha256= prefix', () => {
    const sig = sign(BODY, SECRET);
    expect(verifyHmac256(BODY, sig, SECRET)).toBe(true);
  });

  it('returns true for a valid signature without prefix', () => {
    const hex = crypto.createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(verifyHmac256(BODY, hex, SECRET)).toBe(true);
  });

  it('returns false for a wrong secret', () => {
    const sig = sign(BODY, 'wrong-secret');
    expect(verifyHmac256(BODY, sig, SECRET)).toBe(false);
  });

  it('returns false for a tampered body', () => {
    const sig = sign(BODY, SECRET);
    expect(verifyHmac256(BODY + 'x', sig, SECRET)).toBe(false);
  });

  it('returns false for a malformed hex string', () => {
    expect(verifyHmac256(BODY, 'sha256=not-valid-hex', SECRET)).toBe(false);
  });

  it('returns false for an empty signature', () => {
    expect(verifyHmac256(BODY, '', SECRET)).toBe(false);
  });
});

// -- validateWebhookSignature --

describe('validateWebhookSignature', () => {
  const BASE_OPTIONS = {
    rawBody: BODY,
    secret: SECRET,
    allowInvalidSignature: false,
    acceptUnsigned: false,
  };

  it('returns valid + proceed for a correct signature', () => {
    const sig = sign(BODY, SECRET);
    const result = validateWebhookSignature({
      ...BASE_OPTIONS,
      signature: sig,
    });
    expect(result.outcome).toBe('valid');
    expect(result.proceed).toBe(true);
  });

  it('returns missing + no proceed when signature is undefined', () => {
    const result = validateWebhookSignature({
      ...BASE_OPTIONS,
      signature: undefined,
    });
    expect(result.outcome).toBe('missing');
    expect(result.proceed).toBe(false);
  });

  it('returns missing + proceed when signature is undefined and acceptUnsigned', () => {
    const result = validateWebhookSignature({
      ...BASE_OPTIONS,
      signature: undefined,
      acceptUnsigned: true,
    });
    expect(result.outcome).toBe('missing');
    expect(result.proceed).toBe(true);
  });

  it('returns missing + proceed when signature is undefined and allowInvalidSignature', () => {
    const result = validateWebhookSignature({
      ...BASE_OPTIONS,
      signature: undefined,
      allowInvalidSignature: true,
    });
    expect(result.outcome).toBe('missing');
    expect(result.proceed).toBe(true);
  });

  it('returns missing + no proceed when secret is undefined', () => {
    const sig = sign(BODY, SECRET);
    const result = validateWebhookSignature({
      ...BASE_OPTIONS,
      signature: sig,
      secret: undefined,
    });
    expect(result.outcome).toBe('missing');
    expect(result.proceed).toBe(false);
  });

  it('returns missing + proceed when secret is undefined and allowInvalidSignature', () => {
    const sig = sign(BODY, SECRET);
    const result = validateWebhookSignature({
      ...BASE_OPTIONS,
      signature: sig,
      secret: undefined,
      allowInvalidSignature: true,
    });
    expect(result.outcome).toBe('missing');
    expect(result.proceed).toBe(true);
  });

  it('returns invalid + no proceed for a wrong signature', () => {
    const sig = sign(BODY, 'wrong-secret');
    const result = validateWebhookSignature({
      ...BASE_OPTIONS,
      signature: sig,
    });
    expect(result.outcome).toBe('invalid');
    expect(result.proceed).toBe(false);
    if (result.outcome === 'invalid') {
      expect(result.received).toBe(sig);
    }
  });

  it('returns invalid + proceed when allowInvalidSignature is true', () => {
    const sig = sign(BODY, 'wrong-secret');
    const result = validateWebhookSignature({
      ...BASE_OPTIONS,
      signature: sig,
      allowInvalidSignature: true,
    });
    expect(result.outcome).toBe('invalid');
    expect(result.proceed).toBe(true);
  });

  it('returns invalid + no proceed when only acceptUnsigned is true', () => {
    const sig = sign(BODY, 'wrong-secret');
    const result = validateWebhookSignature({
      ...BASE_OPTIONS,
      signature: sig,
      acceptUnsigned: true,
    });
    expect(result.outcome).toBe('invalid');
    expect(result.proceed).toBe(false);
  });

  it('handles signature without sha256= prefix', () => {
    const hex = crypto.createHmac('sha256', SECRET).update(BODY).digest('hex');
    const result = validateWebhookSignature({
      ...BASE_OPTIONS,
      signature: hex,
    });
    expect(result.outcome).toBe('valid');
    expect(result.proceed).toBe(true);
  });

  it('returns invalid for a tampered body', () => {
    const sig = sign(BODY, SECRET);
    const result = validateWebhookSignature({
      ...BASE_OPTIONS,
      signature: sig,
      rawBody: BODY + 'tampered',
    });
    expect(result.outcome).toBe('invalid');
    expect(result.proceed).toBe(false);
  });
});
