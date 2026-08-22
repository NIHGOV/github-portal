//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

export type ConfigRootRateLimit = {
  rateLimit: ConfigRateLimit;
};

export type ConfigRateLimitMode = 'disabled' | 'audit' | 'enforce';

export type ConfigRateLimit = {
  mode: ConfigRateLimitMode;
  audit: {
    enabled: boolean;
    windowSeconds: number;
    threshold: number;
    thresholdAuthenticated: number;
    thresholdSessionAuthenticated?: number;
    thresholdApiAuthorized?: number;
    thresholdUnauthenticated: number;
    sampleRate: string | number;
    includePathInKey: boolean;
    includeMethodInKey: boolean;
  };
};
