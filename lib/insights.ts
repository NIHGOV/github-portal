//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import Debug from 'debug';
const debug = Debug.debug('insights');

// This file was originally designed to wrap the pre-1.0.0 version of applicationinsights,
// and so is less important today.

import type { TelemetryClient } from 'applicationinsights';

type TelemetryWithProperties = {
  properties?: { [key: string]: unknown };
};

type TelemetryMethodName = 'trackDependency' | 'trackEvent' | 'trackException' | 'trackMetric' | 'trackTrace';

function mergeProperties(
  eventNameOrProperties: unknown,
  commonProperties: { [key: string]: unknown }
): unknown {
  if (!eventNameOrProperties || typeof eventNameOrProperties !== 'object') {
    return eventNameOrProperties;
  }

  const telemetry = eventNameOrProperties as TelemetryWithProperties;
  return {
    ...telemetry,
    properties: {
      ...commonProperties,
      ...(telemetry.properties || {}),
    },
  };
}

function wrapTelemetryMethod(
  client: TelemetryClient,
  methodName: TelemetryMethodName,
  commonProperties: { [key: string]: unknown }
) {
  return (eventNameOrProperties) => {
    const method = client[methodName] as (telemetry: unknown) => void;
    return method.call(client, mergeProperties(eventNameOrProperties, commonProperties));
  };
}

function createConsoleTelemetryClient(): TelemetryClient {
  return {
    trackEvent: consoleHandler,
    trackException: consoleHandler,
    trackMetric: consoleMetric,
    trackTrace: consoleHandler,
    trackDependency: consoleHandler,
    flush: (options) => {
      options = options || {};
      if (options.callback) {
        return (options.callback as any)();
      }
    },
  } as TelemetryClient;
}

function createWrappedClient(propertiesToInsert: any, client: TelemetryClient): TelemetryClient {
  const commonProperties = { ...(propertiesToInsert || {}) };
  const telemetryClient = client || createConsoleTelemetryClient();
  const wrappedClient = Object.create(telemetryClient) as TelemetryClient;

  wrappedClient.commonProperties = commonProperties;
  wrappedClient.trackDependency = wrapTelemetryMethod(
    telemetryClient,
    'trackDependency',
    commonProperties
  ) as TelemetryClient['trackDependency'];
  wrappedClient.trackEvent = wrapTelemetryMethod(
    telemetryClient,
    'trackEvent',
    commonProperties
  ) as TelemetryClient['trackEvent'];
  wrappedClient.trackException = wrapTelemetryMethod(
    telemetryClient,
    'trackException',
    commonProperties
  ) as TelemetryClient['trackException'];
  wrappedClient.trackMetric = wrapTelemetryMethod(
    telemetryClient,
    'trackMetric',
    commonProperties
  ) as TelemetryClient['trackMetric'];
  wrappedClient.trackTrace = wrapTelemetryMethod(
    telemetryClient,
    'trackTrace',
    commonProperties
  ) as TelemetryClient['trackTrace'];
  wrappedClient.flush = telemetryClient.flush
    ? telemetryClient.flush.bind(telemetryClient)
    : createConsoleTelemetryClient().flush;

  return wrappedClient;
}

const consoleHandler = (eventNameOrProperties) => {
  eventNameOrProperties = eventNameOrProperties || {
    name: 'Unknown event, may be from pre-v1.0.0 applicationinsights',
  };
  let props = '';
  if (eventNameOrProperties && eventNameOrProperties.properties) {
    props = ' ';
    for (const [key, value] of Object.entries(eventNameOrProperties.properties)) {
      props += `${key}=${value} `;
    }
  }
  debug(
    (typeof eventNameOrProperties === 'string' ? eventNameOrProperties : eventNameOrProperties.name) + props
  );
};
const consoleMetric = (eventNameOrProperties) => {
  if (typeof eventNameOrProperties === 'string') {
    debug(`Legacy applicationinsights Metric ${eventNameOrProperties} was not recorded`);
  } else {
    eventNameOrProperties = eventNameOrProperties || { name: 'UnknownMetric', value: 0 };
    debug(`Metric(${eventNameOrProperties.name}: ${eventNameOrProperties.value}`);
  }
};

export default createWrappedClient;
