//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { gunzipBuffer, gzipString } from '../utils.js';
import type { ICacheHelper } from './index.js';

type CacheEntry = {
  value: Buffer | string;
  expiresAt?: number;
};

export type IMemoryCacheHelperOptions = {
  prefix?: string;
};

export default class MemoryCacheHelper implements ICacheHelper {
  private _cache = new Map<string, CacheEntry>();
  private _prefix: string;

  constructor(options?: IMemoryCacheHelperOptions) {
    this._prefix = options?.prefix ? `${options.prefix}.` : '';
  }

  private key(key: string) {
    return `${this._prefix}${key}`;
  }

  private getEntry(key: string): CacheEntry {
    const normalizedKey = this.key(key);
    const entry = this._cache.get(normalizedKey);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this._cache.delete(normalizedKey);
      return null;
    }
    return entry;
  }

  private async getValue(key: string, compressed = false): Promise<string> {
    const entry = this.getEntry(key);
    if (!entry) {
      return null;
    }
    if (!compressed) {
      return Buffer.isBuffer(entry.value) ? entry.value.toString('utf8') : entry.value;
    }
    return Buffer.isBuffer(entry.value) ? gunzipBuffer(entry.value) : entry.value;
  }

  private async setValue(key: string, value: Buffer | string, minutesToExpire?: number): Promise<void> {
    const entry: CacheEntry = { value };
    if (minutesToExpire) {
      entry.expiresAt = Date.now() + minutesToExpire * 60 * 1000;
    }
    this._cache.set(this.key(key), entry);
  }

  async get(key: string): Promise<string> {
    return this.getValue(key);
  }

  async getCompressed(key: string): Promise<string> {
    return this.getValue(key, true);
  }

  async getObject<T = any>(key: string): Promise<T> {
    const value = await this.get(key);
    return JSON.parse(value);
  }

  async getObjectCompressed<T = any>(key: string): Promise<T> {
    const value = await this.getCompressed(key);
    return JSON.parse(value);
  }

  async set(key: string, value: string): Promise<void> {
    await this.setValue(key, value);
  }

  async setObject(key: string, value: any): Promise<void> {
    await this.set(key, JSON.stringify(value));
  }

  async setObjectWithExpire(key: string, value: any, minutesToExpire: number): Promise<void> {
    await this.setWithExpire(key, JSON.stringify(value), minutesToExpire);
  }

  async setObjectCompressedWithExpire(key: string, value: any, minutesToExpire: number): Promise<void> {
    await this.setCompressedWithExpire(key, JSON.stringify(value), minutesToExpire);
  }

  async setCompressed(key: string, value: string): Promise<void> {
    const compressed = await gzipString(value);
    await this.setValue(key, compressed);
  }

  async setCompressedWithExpire(key: string, value: string, minutesToExpire: number): Promise<void> {
    if (!minutesToExpire) {
      throw new Error('No minutes to expiration value');
    }
    const compressed = await gzipString(value);
    await this.setValue(key, compressed, minutesToExpire);
  }

  async setWithExpire(key: string, value: string, minutesToExpire: number): Promise<void> {
    if (!minutesToExpire) {
      throw new Error('No minutes to expiration value');
    }
    await this.setValue(key, value, minutesToExpire);
  }

  async expire(key: string, minutesToExpire: number): Promise<void> {
    if (!minutesToExpire) {
      throw new Error('No minutes to expiration value');
    }
    const entry = this.getEntry(key);
    if (!entry) {
      return;
    }
    entry.expiresAt = Date.now() + minutesToExpire * 60 * 1000;
    this._cache.set(this.key(key), entry);
  }

  async delete(key: string): Promise<void> {
    this._cache.delete(this.key(key));
  }

  readonly supportsIncrementWithExpire = true;

  async incrementWithExpire(key: string, minutesToExpire: number): Promise<number> {
    const normalizedKey = this.key(key);
    const entry = this.getEntry(key);
    if (entry) {
      const current = Buffer.isBuffer(entry.value) ? entry.value.toString('utf8') : entry.value;
      const count = (parseInt(current, 10) || 0) + 1;
      entry.value = `${count}`;
      this._cache.set(normalizedKey, entry);
      return count;
    }
    const expiresAt = Date.now() + minutesToExpire * 60 * 1000;
    this._cache.set(normalizedKey, { value: '1', expiresAt });
    return 1;
  }
}
