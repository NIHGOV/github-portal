//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { describe, expect, it } from 'vitest';
import { ServiceBusReceivedMessage } from '@azure/service-bus';

import { ServiceBusMessage } from './servicebus.js';

const BODY = '{"action":"opened","repository":{"full_name":"org/repo"}}';

function createMessage(body: unknown): ServiceBusReceivedMessage {
  return {
    body,
    _rawAmqpMessage: {
      bodyType: 'data',
    },
    applicationProperties: {
      delivery: 'delivery-id',
    },
    messageId: 'message-id',
  } as unknown as ServiceBusReceivedMessage;
}

function createMessageWithoutRawBodyType(body: unknown): ServiceBusReceivedMessage {
  return {
    body,
    applicationProperties: {
      delivery: 'delivery-id',
    },
    messageId: 'message-id',
  } as unknown as ServiceBusReceivedMessage;
}

describe('ServiceBusMessage', () => {
  it('preserves string bodies as unparsedBody', () => {
    const message = new ServiceBusMessage(createMessage(BODY));

    expect(message.unparsedBody).toBe(BODY);
    expect(message.rawBodyType).toBe('data');
    expect(message.body).toEqual(JSON.parse(BODY));
  });

  it('normalizes buffer bodies to utf8 strings', () => {
    const message = new ServiceBusMessage(createMessage(Buffer.from(BODY, 'utf8')));

    expect(message.unparsedBody).toBe(BODY);
    expect(message.rawBodyType).toBe('data');
    expect(message.body).toEqual(JSON.parse(BODY));
  });

  it('rejects parsed object bodies', () => {
    expect(() => new ServiceBusMessage(createMessage(JSON.parse(BODY)))).toThrow(
      'Unsupported Service Bus webhook body type for webhook raw body processing'
    );
  });

  it('throws a specific error with messageId and bodyType for invalid JSON', () => {
    expect(() => new ServiceBusMessage(createMessage('not-valid-json'))).toThrow(
      'Invalid JSON body for Service Bus message message-id (bodyType: data)'
    );
  });

  it('throws a specific error without bodyType when rawAmqpMessage is absent', () => {
    expect(() => new ServiceBusMessage(createMessageWithoutRawBodyType('not-valid-json'))).toThrow(
      'Invalid JSON body for Service Bus message message-id'
    );
  });

  it('treats raw body type as best-effort telemetry when the SDK field is absent', () => {
    const message = new ServiceBusMessage(createMessageWithoutRawBodyType(BODY));

    expect(message.unparsedBody).toBe(BODY);
    expect(message.rawBodyType).toBeUndefined();
    expect(message.body).toEqual(JSON.parse(BODY));
  });
});
