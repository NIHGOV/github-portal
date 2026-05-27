//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import crypto from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetProviders, mockIsWebhookIngestionEndpointEnabled, mockOrganizationWebhookProcessor } =
  vi.hoisted(() => ({
    mockGetProviders: vi.fn(),
    mockIsWebhookIngestionEndpointEnabled: vi.fn(),
    mockOrganizationWebhookProcessor: vi.fn(),
  }));

vi.mock('../lib/transitional.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/transitional.js')>();
  return {
    ...actual,
    getProviders: mockGetProviders,
    isWebhookIngestionEndpointEnabled: mockIsWebhookIngestionEndpointEnabled,
  };
});

vi.mock('../business/webhooks/organizationProcessor.js', () => ({
  default: mockOrganizationWebhookProcessor,
}));

import router from './webhook.js';

function sign(body: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function createRawBody() {
  return JSON.stringify({
    action: 'opened',
    organization: {
      login: 'test-org',
    },
  });
}

function createRequest(overrides: Record<string, unknown> = {}) {
  return {
    body: {
      action: 'opened',
      organization: {
        login: 'test-org',
      },
    },
    headers: {
      'x-github-delivery': 'delivery-1',
      'x-github-event': 'issues',
    },
    insights: {},
    organization: undefined,
    ...overrides,
  };
}

function createResponse() {
  const response = {
    json: vi.fn(),
    status: vi.fn().mockReturnThis(),
  };
  return response;
}

type WebhookHandler = (
  request: ReturnType<typeof createRequest>,
  response: ReturnType<typeof createResponse>,
  next: (error?: unknown) => void
) => Promise<unknown> | unknown;

function getHandler() {
  return (router as any).stack[0].handle as WebhookHandler;
}

describe('api webhook route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsWebhookIngestionEndpointEnabled.mockReturnValue(true);
    mockGetProviders.mockReturnValue({
      config: {
        github: {
          webhooks: {
            sharedSecret: 'test-secret',
            allowInvalidSignature: false,
            acceptUnsigned: false,
          },
        },
      },
      operations: {
        getOrganization: vi.fn().mockReturnValue({
          active: true,
          name: 'test-org',
        }),
      },
    });
  });

  it('rejects requests without x-hub-signature-256', async () => {
    const request = createRequest({
      _raw: createRawBody(),
    });
    const response = createResponse();
    const next = vi.fn();

    await getHandler()(request, response, next);

    expect(mockOrganizationWebhookProcessor).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0][0];
    expect(error.statusCode).toBe(401);
    expect(error.message).toBe('Missing or unconfigured X-Hub-Signature-256');
  });

  it('rejects requests when the raw body is unavailable', async () => {
    const request = createRequest({
      _raw: undefined,
      headers: {
        'x-github-delivery': 'delivery-1',
        'x-github-event': 'issues',
        'x-hub-signature-256': sign(createRawBody(), 'test-secret'),
      },
    });
    const response = createResponse();
    const next = vi.fn();

    await getHandler()(request, response, next);

    expect(mockOrganizationWebhookProcessor).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0][0];
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe('Missing HTTP webhook raw body for webhook raw body processing');
  });

  it('accepts requests with a valid x-hub-signature-256', async () => {
    const rawBody = createRawBody();
    const request = createRequest({
      _raw: rawBody,
      headers: {
        'x-github-delivery': 'delivery-1',
        'x-github-event': 'issues',
        'x-hub-signature-256': sign(rawBody, 'test-secret'),
      },
    });
    const response = createResponse();
    const next = vi.fn();

    mockOrganizationWebhookProcessor.mockResolvedValue(1);

    await getHandler()(request, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockOrganizationWebhookProcessor).toHaveBeenCalledOnce();
    expect(mockOrganizationWebhookProcessor).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          rawBody,
        }),
      })
    );
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(1);
  });

  it('accepts unsigned requests when acceptUnsigned is enabled', async () => {
    const rawBody = createRawBody();
    mockGetProviders.mockReturnValue({
      config: {
        github: {
          webhooks: {
            sharedSecret: 'test-secret',
            allowInvalidSignature: false,
            acceptUnsigned: true,
          },
        },
      },
      operations: {
        getOrganization: vi.fn().mockReturnValue({
          active: true,
          name: 'test-org',
        }),
      },
    });
    const request = createRequest({
      _raw: rawBody,
    });
    const response = createResponse();
    const next = vi.fn();

    mockOrganizationWebhookProcessor.mockResolvedValue(1);

    await getHandler()(request, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockOrganizationWebhookProcessor).toHaveBeenCalledOnce();
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(1);
  });

  it('accepts requests with an invalid x-hub-signature-256 when allowInvalidSignature is enabled', async () => {
    const rawBody = createRawBody();
    mockGetProviders.mockReturnValue({
      config: {
        github: {
          webhooks: {
            sharedSecret: 'test-secret',
            allowInvalidSignature: true,
            acceptUnsigned: false,
          },
        },
      },
      operations: {
        getOrganization: vi.fn().mockReturnValue({
          active: true,
          name: 'test-org',
        }),
      },
    });
    const request = createRequest({
      _raw: rawBody,
      headers: {
        'x-github-delivery': 'delivery-1',
        'x-github-event': 'issues',
        'x-hub-signature-256': sign(rawBody, 'wrong-secret'),
      },
    });
    const response = createResponse();
    const next = vi.fn();

    mockOrganizationWebhookProcessor.mockResolvedValue(1);

    await getHandler()(request, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockOrganizationWebhookProcessor).toHaveBeenCalledOnce();
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(1);
  });

  it('rejects invalid x-hub-signature-256 when only acceptUnsigned is enabled', async () => {
    const rawBody = createRawBody();
    mockGetProviders.mockReturnValue({
      config: {
        github: {
          webhooks: {
            sharedSecret: 'test-secret',
            allowInvalidSignature: false,
            acceptUnsigned: true,
          },
        },
      },
      operations: {
        getOrganization: vi.fn().mockReturnValue({
          active: true,
          name: 'test-org',
        }),
      },
    });
    const request = createRequest({
      _raw: rawBody,
      headers: {
        'x-github-delivery': 'delivery-1',
        'x-github-event': 'issues',
        'x-hub-signature-256': sign(rawBody, 'wrong-secret'),
      },
    });
    const response = createResponse();
    const next = vi.fn();

    await getHandler()(request, response, next);

    expect(mockOrganizationWebhookProcessor).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    const error = next.mock.calls[0][0];
    expect(error.statusCode).toBe(401);
    expect(error.message).toBe('Invalid X-Hub-Signature-256');
  });
});
