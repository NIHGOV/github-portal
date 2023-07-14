//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

export type ConfigGitHubUserRootInitialCommit = {
  initialCommit: ConfigGitHubUserInitialCommit;
};

export type ConfigGitHubUserInitialCommit = {
  username: string;
  token: string;
};
