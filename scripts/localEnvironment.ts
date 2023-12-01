//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

// The local environment script is designed to allow for local debugging, test and
// development scenarios. The go method is called with resolved configuration.

async function go(providers: IProviders): Promise<void> {
  // ---------------------------------------------------------------------------
}

// -----------------------------------------------------------------------------
// Local script initialization
// -----------------------------------------------------------------------------
import app from '../app';
import { IProviders, IReposJob } from '../interfaces';

app.runJob(
  async function ({ providers }: IReposJob) {
    await go(providers);
    return {};
  },
  {
    enableAllGitHubApps: true,
  }
);
