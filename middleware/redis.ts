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
  const redisOptions: any = { socket };
  if (config.redis.key) {
    redisOptions.password = config.redis.key;
  }
  debug(`connecting to ${purpose} Redis ${redisConfig.host || redisConfig.tls}`);
  const redisClient: RedisClientType = createClient(redisOptions);
  await redisClient.connect();

  return redisClient;
}
