//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import jose from 'node-jose';
import jwksClient from 'jwks-rsa';
import { describe, expect, it } from 'vitest';
import { base64url } from 'jose';

const ISSUER = 'https://login.microsoftonline.com/test-tenant/v2.0';
const AUDIENCE = 'test-audience';
const TEST_HMAC_KEY = 'unit-test-only-hs256-key-0001';
const TEST_JWKS_URI = 'https://example.test/discovery/keys';
const TEST_KEY_ID = 'unit-test-rsa-key';

describe('jose and jwt runtime interop', () => {
  it('supports jose base64url encode as used by GitHub app JWT creation', () => {
    const header = JSON.stringify({ alg: 'RS256', typ: 'JWT' });
    const payload = JSON.stringify({ iss: '123', iat: 1, exp: 2 });

    const encodedHeader = base64url.encode(header);
    const encodedPayload = base64url.encode(payload);

    // cspell:ignore eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9 eyJpc3MiOiIxMjMiLCJpYXQiOjEsImV4cCI6Mn0
    expect(encodedHeader).toBe('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(encodedPayload).toBe('eyJpc3MiOiIxMjMiLCJpYXQiOjEsImV4cCI6Mn0');
  });

  it('supports jsonwebtoken default import decode and verify with a callback key resolver', async () => {
    const token = jwt.sign(
      {
        appid: 'test-client-id',
        oid: 'test-object-id',
        tid: 'test-tenant-id',
      },
      TEST_HMAC_KEY,
      {
        algorithm: 'HS256',
        issuer: ISSUER,
        audience: AUDIENCE,
        expiresIn: '5m',
      }
    );

    const decoded = jwt.decode(token);
    expect(decoded).toBeTruthy();
    expect(decoded).toMatchObject({ iss: ISSUER, aud: AUDIENCE });

    const verified = await new Promise<object>((resolve, reject) => {
      jwt.verify(
        token,
        (header, callback) => {
          expect(header.alg).toBe('HS256');
          callback(null, TEST_HMAC_KEY);
        },
        {
          issuer: ISSUER,
          audience: AUDIENCE,
        },
        (error, payload) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(payload as object);
        }
      );
    });

    expect(verified).toMatchObject({
      iss: ISSUER,
      aud: AUDIENCE,
      appid: 'test-client-id',
      oid: 'test-object-id',
      tid: 'test-tenant-id',
    });
  });

  it('supports node-jose default import JWA encrypt decrypt and util.asBuffer', async () => {
    const keyEncryptionKey = crypto.randomBytes(32);
    const contentEncryptionKey = crypto.randomBytes(32);

    const wrapped = await jose.JWA.encrypt('A256KW', keyEncryptionKey, contentEncryptionKey);
    const wrappedBuffer = jose.util.asBuffer(wrapped.data);
    const unwrapped = await jose.JWA.decrypt('A256KW', keyEncryptionKey, wrappedBuffer);

    expect(Buffer.isBuffer(wrappedBuffer)).toBe(true);
    expect(Buffer.compare(Buffer.from(unwrapped), contentEncryptionKey)).toBe(0);
  });

  it('supports jwks-rsa default import and callback-based jwt verification with a fetched signing key', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });

    const jwk = {
      ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
      use: 'sig',
      kid: TEST_KEY_ID,
      alg: 'RS256',
    };

    const client = jwksClient({
      jwksUri: TEST_JWKS_URI,
      cache: false,
      rateLimit: false,
      fetcher: async (jwksUri) => {
        expect(jwksUri).toBe(TEST_JWKS_URI);
        return { keys: [jwk] };
      },
    });

    const signingKey = await client.getSigningKey(TEST_KEY_ID);
    expect(signingKey.getPublicKey()).toContain('BEGIN PUBLIC KEY');
    expect(signingKey.getPublicKey()).toBe(
      'publicKey' in signingKey ? signingKey.publicKey : signingKey.rsaPublicKey
    );

    const token = jwt.sign(
      {
        appid: 'test-client-id',
        oid: 'test-object-id',
        tid: 'test-tenant-id',
      },
      privateKey,
      {
        algorithm: 'RS256',
        keyid: TEST_KEY_ID, // @cspell: ignore keyid
        issuer: ISSUER,
        audience: AUDIENCE,
        expiresIn: '5m',
      }
    );

    const verified = await new Promise<object>((resolve, reject) => {
      jwt.verify(
        token,
        (header, callback) => {
          void client
            .getSigningKey(header.kid)
            .then((key) => {
              callback(null, key.getPublicKey());
            })
            .catch((error) => {
              callback(error);
            });
        },
        {
          issuer: ISSUER,
          audience: AUDIENCE,
        },
        (error, payload) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(payload as object);
        }
      );
    });

    expect(verified).toMatchObject({
      iss: ISSUER,
      aud: AUDIENCE,
      appid: 'test-client-id',
      oid: 'test-object-id',
      tid: 'test-tenant-id',
    });
  });
});
