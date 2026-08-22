//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { Organization } from '../index.js';
import { sleep } from '../../lib/utils.js';

import type { AppInsightsTelemetryClient, IProviders } from '../../interfaces/index.js';

import defaultWebhookTasks from './tasks/index.js';
import getCompanySpecificDeployment from '../../middleware/companySpecificDeployment.js';

let companySpecificWebhookTasks: WebhookProcessor[] = null;

export abstract class WebhookProcessor {
  abstract filter(data: any): boolean;
  abstract run(
    providers: IProviders,
    insights: AppInsightsTelemetryClient,
    organization: Organization,
    data: any
  ): Promise<boolean>;
}

export type OrganizationWebhookEvent<T = any> = {
  body: T;
  rawBody?: any;
  properties: GitHubWebhookProperties;
};

export type GitHubWebhookProperties = {
  delivery: string;
  signature: string;
  event: string;
  started: string; // Date UTC string
};

export type ProcessOrganizationWebhookOptions = {
  insights: AppInsightsTelemetryClient;
  providers: IProviders;
  organization: Organization;
  event: OrganizationWebhookEvent;
  acknowledgeValidEvent?: any;
};

export default async function ProcessOrganizationWebhook(
  options: ProcessOrganizationWebhookOptions
): Promise<any> {
  const providers = options.providers;
  if (!providers) {
    throw new Error('No providers provided');
  }
  const { insights } = options;
  const companySpecific = getCompanySpecificDeployment();
  if (
    companySpecific?.features?.firehose?.getAdditionalWebhookTasks &&
    companySpecificWebhookTasks === null
  ) {
    companySpecificWebhookTasks =
      await companySpecific.features.firehose.getAdditionalWebhookTasks(providers);
  }
  const organization = options.organization;
  const event = options.event;
  if (!organization || !organization.name) {
    throw new Error('Missing organization instance');
  }
  if (!organization.active) {
    console.log(`inactive or unadopted organization ${organization.name}`);
    if (options.acknowledgeValidEvent) {
      options.acknowledgeValidEvent();
    }
    return;
  }
  if (!event) {
    throw new Error('Missing event');
  }
  if (!event.body) {
    throw new Error('Missing event body');
  }
  const properties = event.properties;
  if (!properties || !properties.delivery || !properties.event) {
    if (options.acknowledgeValidEvent) {
      options.acknowledgeValidEvent();
    }
    throw new Error('Missing event properties - delivery and/or event');
  }

  // In a bus scenario, if a short timeout window is used for queue
  // visibility, a client may want to acknowledge this being a valid
  // event at this time. After this point however there is no
  // guarantee of successful execution.
  if (options.acknowledgeValidEvent) {
    options.acknowledgeValidEvent();
  }
  let interestingEvents = 0;
  const availableTasks = [...defaultWebhookTasks, ...(companySpecificWebhookTasks || [])];
  const work = availableTasks.filter((task) => task.filter(event));
  if (work.length > 0) {
    ++interestingEvents;
    console.log(`[* interesting event: ${event.properties.event} (${work.length} interested tasks)]`);
  } else {
    console.log(`[uninteresting event: ${event.properties.event}]`);
  }

  for (const processor of work) {
    try {
      await processor.run(providers, insights, organization, event);
    } catch (processInitializationError) {
      if (processInitializationError.status === 403) {
        console.log(`403: ${processInitializationError}`);
        if (processInitializationError.headers) {
          const headers = processInitializationError.headers;
          const rateLimit = headers['x-ratelimit-limit'];
          const rateLimitRemaining = headers['x-ratelimit-remaining'];
          const rateLimitReset = headers['x-ratelimit-reset'];
          if (rateLimit !== undefined) {
            console.log(`rate limit=${rateLimit}, remaining=${rateLimitRemaining}`);
          }
          if (rateLimitReset) {
            const resetValue = Number(rateLimitReset);
            const resetDate = new Date(1000 * resetValue);
            const now = new Date();
            if (resetDate > now) {
              const difference = resetDate.getTime() - now.getTime();
              console.log(
                `[rate limit sleep] This thread will sleep for the remainder of this limit, ${difference}ms, until ${resetDate}`
              );
              await sleep(difference);
              console.log('[resuming from rate limit sleep]');
            }
          }
        }
      } else {
        console.log('Processor ran into an error with an event:');
        console.dir(processInitializationError);
      }
    }
  }
  return interestingEvents;
}
