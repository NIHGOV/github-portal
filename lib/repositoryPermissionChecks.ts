//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { RepositoryFeatureUseMode } from '../interfaces/index.js';
import getCompanySpecificDeployment from '../middleware/companySpecificDeployment.js';

import type { IContextualRepositoryPermissions } from '../middleware/github/repoPermissions.js';

export type PermissionCheckResult = {
  allowed: boolean;
  requiresApproval: boolean;
};

export function checkArchivistPermission(
  permissions: IContextualRepositoryPermissions
): PermissionCheckResult {
  const deployment = getCompanySpecificDeployment();
  if (deployment?.features?.repositoryActions?.allowArchivist) {
    const mode = deployment.features.repositoryActions.allowArchivist(permissions);
    return {
      allowed: mode !== RepositoryFeatureUseMode.None,
      requiresApproval: mode === RepositoryFeatureUseMode.WithApproval,
    };
  }
  return { allowed: permissions.allowAdministration, requiresApproval: false };
}

export function checkDeletePermission(permissions: IContextualRepositoryPermissions): PermissionCheckResult {
  const deployment = getCompanySpecificDeployment();
  if (deployment?.features?.repositoryActions?.allowPermanentlyDelete) {
    const mode = deployment.features.repositoryActions.allowPermanentlyDelete(permissions);
    return {
      allowed: mode !== RepositoryFeatureUseMode.None,
      requiresApproval: mode === RepositoryFeatureUseMode.WithApproval,
    };
  }
  return { allowed: permissions.allowAdministration, requiresApproval: false };
}
