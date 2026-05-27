//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { describe, expect, it, vi } from 'vitest';

import createWrappedClient from './insights.js';

import type { TelemetryClient } from 'applicationinsights';

function createFakeTelemetryClient() {
  return {
    commonProperties: { shared: 'client' },
    trackDependency: vi.fn(),
    trackEvent: vi.fn(),
    trackException: vi.fn(),
    trackMetric: vi.fn(),
    trackTrace: vi.fn(),
    flush: vi.fn(),
  } as unknown as TelemetryClient;
}

describe('insights wrapper', () => {
  it('merges request common properties into telemetry without mutating the shared client', () => {
    const client = createFakeTelemetryClient();
    const wrappedClient = createWrappedClient({ correlationId: 'request-1' }, client);

    wrappedClient.trackEvent({
      name: 'api.entra_id.authorized',
      properties: {
        authorizedScopes: 'read',
      },
    });

    expect(client.trackEvent).toHaveBeenCalledWith({
      name: 'api.entra_id.authorized',
      properties: {
        correlationId: 'request-1',
        authorizedScopes: 'read',
      },
    });
    expect(client.commonProperties).toEqual({ shared: 'client' });
  });

  it('keeps common properties isolated between wrappers created from the same client', () => {
    const client = createFakeTelemetryClient();
    const firstRequest = createWrappedClient({ correlationId: 'request-1' }, client);
    const secondRequest = createWrappedClient({ correlationId: 'request-2' }, client);

    firstRequest.commonProperties.aadId = 'user-1';

    firstRequest.trackEvent({ name: 'first-request' });
    secondRequest.trackEvent({ name: 'second-request' });

    expect(client.trackEvent).toHaveBeenNthCalledWith(1, {
      name: 'first-request',
      properties: {
        correlationId: 'request-1',
        aadId: 'user-1',
      },
    });
    expect(client.trackEvent).toHaveBeenNthCalledWith(2, {
      name: 'second-request',
      properties: {
        correlationId: 'request-2',
      },
    });
  });

  it('lets explicit telemetry properties override request-scoped defaults', () => {
    const client = createFakeTelemetryClient();
    const wrappedClient = createWrappedClient({ correlationId: 'request-1' }, client);

    wrappedClient.trackException({
      exception: new Error('boom'),
      properties: {
        correlationId: 'explicit-id',
      },
    });

    expect(client.trackException).toHaveBeenCalledWith({
      exception: expect.any(Error),
      properties: {
        correlationId: 'explicit-id',
      },
    });
  });
});
