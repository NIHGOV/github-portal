//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { IProviders, LocalApiRepoAction } from '../../index.js';
import { Repository } from '../../../business/index.js';
import { IndividualContext } from '../../../business/user/index.js';

import type { IContextualRepositoryPermissions } from '../../../middleware/github/repoPermissions.js';

export enum RepositoryFeatureUseMode {
  None = 'none',
  WithApproval = 'approval',
  WithoutApproval = 'without-approval',
}

export type RepositoryActionApprovalResult = {
  requiresApproval: boolean;
  requestSubmitted?: boolean;
  grantId?: string;
  approvalUrl?: string;
  message?: string;
  error?: string;
};

export interface ICompanySpecificFeatureRepositoryState {
  getCurrentRepositoryState(providers: IProviders, repository: Repository): Promise<unknown>;
  sendActionReceipt(
    providers: IProviders,
    context: IndividualContext,
    repository: Repository,
    action: LocalApiRepoAction,
    currentState: unknown
  ): Promise<void>;
  allowArchivist?(permissions: IContextualRepositoryPermissions): RepositoryFeatureUseMode;
  allowPermanentlyDelete?(permissions: IContextualRepositoryPermissions): RepositoryFeatureUseMode;
  submitActionForApproval?(
    providers: IProviders,
    context: IndividualContext,
    repository: Repository,
    action: LocalApiRepoAction,
    justification: string
  ): Promise<RepositoryActionApprovalResult>;
}
