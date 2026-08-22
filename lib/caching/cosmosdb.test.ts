//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PatchOperationType } from '@azure/cosmos';

import CosmosCache from './cosmosdb.js';

function createCosmosError(statusCode: number, message = 'error'): Error {
  const error = new Error(message);
  (error as any).code = statusCode;
  return error;
}

function createMockCollection() {
  const patchFn = vi.fn();
  const createFn = vi.fn();
  return {
    patchFn,
    createFn,
    collection: {
      item: vi.fn((_id: string, _pk: string) => ({
        patch: patchFn,
        read: vi.fn(),
        delete: vi.fn(),
      })),
      items: {
        upsert: vi.fn(),
        create: createFn,
      },
    },
  };
}

function createInitializedCache(collection: any): CosmosCache {
  // cspell:ignore fakekey testdb testcol
  const cache = new CosmosCache({
    endpoint: 'https://fake.documents.azure.com:443/',
    key: 'fakekey==',
    database: 'testdb',
    collection: 'testcol',
  });
  (cache as any)._initialized = true;
  (cache as any)._collection = collection;
  return cache;
}

describe('CosmosCache incrementWithExpire', () => {
  let mock: ReturnType<typeof createMockCollection>;
  let cache: CosmosCache;

  beforeEach(() => {
    mock = createMockCollection();
    cache = createInitializedCache(mock.collection);
  });

  it('increments an existing document with a single patch call', async () => {
    mock.patchFn.mockResolvedValueOnce({ resource: { count: 5 } });

    const result = await cache.incrementWithExpire('ratelimit:abc', 2);

    expect(result).toBe(5);
    expect(mock.patchFn).toHaveBeenCalledOnce();
    expect(mock.patchFn).toHaveBeenCalledWith({
      operations: [{ op: PatchOperationType.incr, path: '/count', value: 1 }],
    });
    expect(mock.createFn).not.toHaveBeenCalled();
  });

  it('creates a new document when patch returns 404 (cold start)', async () => {
    mock.patchFn.mockRejectedValueOnce(createCosmosError(404));
    mock.createFn.mockResolvedValueOnce({});

    const result = await cache.incrementWithExpire('ratelimit:new', 1);

    expect(result).toBe(1);
    expect(mock.patchFn).toHaveBeenCalledOnce();
    expect(mock.createFn).toHaveBeenCalledOnce();
    expect(mock.createFn).toHaveBeenCalledWith(expect.objectContaining({ count: 1, ttl: 60 }));
  });

  it('retries patch after 409 conflict on create (race condition)', async () => {
    mock.patchFn
      .mockRejectedValueOnce(createCosmosError(404))
      .mockResolvedValueOnce({ resource: { count: 2 } });
    mock.createFn.mockRejectedValueOnce(createCosmosError(409));

    const result = await cache.incrementWithExpire('ratelimit:race', 1);

    expect(result).toBe(2);
    expect(mock.patchFn).toHaveBeenCalledTimes(2);
    expect(mock.createFn).toHaveBeenCalledOnce();
  });

  it('propagates non-404 patch errors', async () => {
    mock.patchFn.mockRejectedValueOnce(createCosmosError(500, 'server error'));

    await expect(cache.incrementWithExpire('ratelimit:err', 1)).rejects.toThrow('server error');
    expect(mock.createFn).not.toHaveBeenCalled();
  });

  it('propagates non-409 create errors', async () => {
    mock.patchFn.mockRejectedValueOnce(createCosmosError(404));
    mock.createFn.mockRejectedValueOnce(createCosmosError(403, 'forbidden'));

    await expect(cache.incrementWithExpire('ratelimit:denied', 1)).rejects.toThrow('forbidden');
  });

  it('throws when not initialized', async () => {
    // cspell:ignore uninit
    const uninitCache = new CosmosCache({
      endpoint: 'https://fake.documents.azure.com:443/',
      key: 'fakekey==',
      database: 'testdb',
      collection: 'testcol',
    });

    await expect(uninitCache.incrementWithExpire('key', 1)).rejects.toThrow(
      'Cosmos caching provider must be initialized'
    );
  });

  it('sets ttl based on minutesToExpire when creating', async () => {
    mock.patchFn.mockRejectedValueOnce(createCosmosError(404));
    mock.createFn.mockResolvedValueOnce({});

    await cache.incrementWithExpire('ratelimit:ttl', 5);

    expect(mock.createFn).toHaveBeenCalledWith(expect.objectContaining({ ttl: 300 }));
  });
});
