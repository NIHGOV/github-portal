//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

// PUSH: keep the query cache's pushed_at fresh from the firehose instead of waiting on the slow refresh job

import { WebhookProcessor } from '../organizationProcessor.js';
import { Organization } from '../../index.js';
import type { AppInsightsTelemetryClient, IProviders } from '../../../interfaces/index.js';
import type { GitHubWebhookOrganization, GitHubWebhookSender, GitHubWebhookInstallation } from '../types.js';
import type { GitHubRepositoryBaseDetails } from '../../../interfaces/index.js';

type GitHubWebhookPushEventBody = {
  repository: GitHubRepositoryBaseDetails;
  organization: GitHubWebhookOrganization;
  sender: GitHubWebhookSender;
  installation: GitHubWebhookInstallation;
};

export default class PushWebhookProcessor implements WebhookProcessor {
  filter(data: any) {
    const eventType = data.properties.event;
    return eventType === 'push';
  }

  async run(
    providers: IProviders,
    insights: AppInsightsTelemetryClient,
    organization: Organization,
    data: any
  ): Promise<boolean> {
    const { operations } = providers;
    const event = data.body as GitHubWebhookPushEventBody;
    const queryCache = operations.providers.queryCache;
    const organizationId = event?.organization?.id as number;
    const repositoryId = event?.repository?.id as number;
    if (!organizationId || !repositoryId) {
      return true;
    }
    if (!operations.isOrganizationManagedById(organizationId)) {
      console.log(
        `skipping organization ID ${organizationId} which is not directly managed: ${event.organization.login}`
      );
      return true;
    }
    const organizationIdAsString = String(organizationId);
    const repositoryIdAsString = String(repositoryId);
    try {
      if (
        organizationIdAsString === organization.id.toString() &&
        queryCache &&
        queryCache.supportsOrganizationMembership
      ) {
        await queryCache.addOrUpdateRepository(
          organizationIdAsString,
          repositoryIdAsString,
          event.repository
        );
      }
    } catch (queryCacheError) {
      console.dir(queryCacheError);
    }
    return true;
  }
}
