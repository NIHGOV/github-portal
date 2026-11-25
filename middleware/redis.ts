//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import Debug from 'debug';
import { createClient, RedisClientType } from 'redis';

import type { SiteConfiguration } from '../interfaces/index.js';

const debug = Debug.debug('startup');

export async function connectRedis(
  config: SiteConfiguration,
  redisConfig: any,
  purpose: string
): Promise<RedisClientType> {
  const useTls = !!config.redis.tls;
  const socket: any = {
    host: config.redis.tls || config.redis.host,
    port: config.redis.port ? Number(config.redis.port) : useTls ? 6380 : 6379,
  };
  if (useTls) {
    socket.tls = true;
  }
  const redisOptions: any = {
    socket,
    // Ping periodically so idle connections (e.g. the low-traffic firehose container) aren't
    // silently closed by Azure Cache for Redis's idle-connection timeout.
    // https://learn.microsoft.com/en-us/azure/azure-cache-for-redis/cache-best-practices-connection#idle-timeout
    pingInterval: 5 * 60 * 1000,
  };
  if (config.redis.key) {
    redisOptions.password = config.redis.key;
  }
  debug(`connecting to ${purpose} Redis ${redisConfig.host || redisConfig.tls}`);
  const redisClient: RedisClientType = createClient(redisOptions);
  // without this listener, socket errors (e.g. idle disconnects) become unhandled exceptions and crash the process
  redisClient.on('error', (err) => {
    debug(`${purpose} Redis client error: ${err?.message || err}`);
  });
  await redisClient.connect();

  return redisClient;
}
