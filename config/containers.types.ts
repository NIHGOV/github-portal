//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

export type ConfigRootContainers = {
  containers: ConfigContainers;
};

export type ConfigContainers = {
  docker: boolean;
  deployment: boolean;
};
