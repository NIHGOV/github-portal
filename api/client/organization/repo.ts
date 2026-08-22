//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { NextFunction, Response, Router } from 'express';

import { CreateError, ErrorHelper, getProviders } from '../../../lib/transitional.js';
import { IndividualContext } from '../../../business/user/index.js';
import NewRepositoryLockdownSystem from '../../../business/features/newRepositories/newRepositoryLockdown.js';
import {
  AddRepositoryPermissionsToRequest,
  getContextualRepositoryPermissions,
} from '../../../middleware/github/repoPermissions.js';
import getCompanySpecificDeployment from '../../../middleware/companySpecificDeployment.js';

import RouteRepoPermissions from './repoPermissions.js';
import {
  LocalApiRepoAction,
  getRepositoryMetadataProvider,
  NoCacheNoBackground,
  GitHubRepositoryVisibility,
} from '../../../interfaces/index.js';
import { RequestWithRepo } from '../../../middleware/business/repository.js';
import { checkArchivistPermission, checkDeletePermission } from '../../../lib/repositoryPermissionChecks.js';

enum RepositoryChangeAction {
  Archive,
  UnArchive,
  Privatize,
}

const router: Router = Router();

const deployment = getCompanySpecificDeployment();
if (deployment?.routes?.api?.organization?.repo) {
  deployment?.routes?.api?.organization?.repo(router);
}

router.use('/permissions', RouteRepoPermissions);

router.get('/', async (req: RequestWithRepo, res: Response, next: NextFunction) => {
  const { repository } = req;
  try {
    await repository.getDetails(NoCacheNoBackground);
    const clone = Object.assign({}, repository.getEntity());
    delete (clone as any).temp_clone_token; // never share this back
    delete (clone as any).cost;

    return res.json(clone) as unknown as void;
  } catch (repoError) {
    if (ErrorHelper.IsNotFound(repoError)) {
      // // Attempt fallback by ID (?)
    }
    return next(repoError);
  }
});

router.get('/exists', async (req: RequestWithRepo, res: Response, next: NextFunction) => {
  let exists = false;
  let name: string = undefined;
  const { repository } = req;
  try {
    const originalName = repository.name;
    await repository.getDetails();
    if (repository && repository.name) {
      name = repository.getEntity().name as string;
      if (name.toLowerCase() !== originalName.toLowerCase()) {
        // A renamed repository will return the new name here
        exists = false;
      } else {
        exists = true;
      }
    }
  } catch (repoError) {}
  return res.json({ exists, name }) as unknown as void;
});

router.get('/archived', async (req: RequestWithRepo, res: Response, next: NextFunction) => {
  const { repository } = req;
  try {
    await repository.getDetails();
    const data = {
      archivedAt: null,
    };
    if (repository?.archived) {
      const archivedAt = await repository.getArchivedAt();
      if (archivedAt) {
        data.archivedAt = archivedAt.toISOString();
      }
    }
    return res.json(data) as unknown as void;
  } catch (error) {
    return next(error);
  }
});

router.post(
  '/privatize',
  AddRepositoryPermissionsToRequest,
  RepositoryStateChangeHandler.bind(null, RepositoryChangeAction.Privatize)
);

router.post(
  '/archive',
  AddRepositoryPermissionsToRequest,
  RepositoryStateChangeHandler.bind(null, RepositoryChangeAction.Archive)
);

router.post(
  '/unarchive',
  AddRepositoryPermissionsToRequest,
  RepositoryStateChangeHandler.bind(null, RepositoryChangeAction.UnArchive)
);

async function RepositoryStateChangeHandler(
  action: RepositoryChangeAction,
  req: RequestWithRepo,
  res: Response,
  next: NextFunction
) {
  const activeContext = (req.individualContext || req.apiContext) as IndividualContext;
  const corporateId = activeContext.link.corporateId;
  const providers = getProviders(req);
  const { insights, repository } = req;
  const repoPermissions = getContextualRepositoryPermissions(req);
  let phrase: string = null;
  let insightsPrefix: string = null;
  let localAction: LocalApiRepoAction = null;
  switch (action) {
    case RepositoryChangeAction.Archive:
      phrase = 'archive';
      insightsPrefix = 'ArchiveRepo';
      localAction = LocalApiRepoAction.Archive;
      break;
    case RepositoryChangeAction.UnArchive:
      phrase = 'unarchive';
      insightsPrefix = 'UnArchiveRepo';
      localAction = LocalApiRepoAction.UnArchive;
      break;
    case RepositoryChangeAction.Privatize:
      phrase = 'privatize';
      insightsPrefix = 'PrivatizeRepo';
      localAction = LocalApiRepoAction.Privatize;
      break;
    default:
      return next(CreateError.InvalidParameters('Invalid action'));
  }
  const completedPhrase = `${phrase}d`;
  const isArchivistAction =
    action === RepositoryChangeAction.Archive || action === RepositoryChangeAction.UnArchive;
  const permissionCheck = isArchivistAction
    ? checkArchivistPermission(repoPermissions)
    : { allowed: repoPermissions.allowAdministration, requiresApproval: false };
  if (!permissionCheck.allowed) {
    return next(CreateError.NotAuthorized(`You do not have permission to ${phrase} this repo`));
  }
  if (permissionCheck.requiresApproval) {
    // Use the company-specific approval workflow
    if (!deployment?.features?.repositoryActions?.submitActionForApproval) {
      return next(
        CreateError.FeatureNotEnabled(
          `This action requires approval but the approval workflow is not configured.`
        )
      );
    }
    const justification = req.body?.justification || 'No justification provided';
    try {
      const result = await deployment.features.repositoryActions.submitActionForApproval(
        providers,
        activeContext,
        repository,
        localAction,
        justification
      );
      if (result.error) {
        return next(CreateError.InvalidParameters(result.error));
      }
      return res.status(202).json({
        message:
          result.message ||
          `Your request to ${phrase} ${repository.full_name} has been submitted for approval.`,
        requiresApproval: true,
        requestSubmitted: result.requestSubmitted,
        grantId: result.grantId,
        approvalUrl: result.approvalUrl,
      }) as unknown as void;
    } catch (approvalError) {
      return next(CreateError.ServerError(approvalError.message, approvalError));
    }
  }
  try {
    insights?.trackEvent({
      name: `${insightsPrefix}Started`,
      properties: {
        requestedById: corporateId,
        repoName: repository.name,
        orgName: repository.organization.name,
        repoId: repository.id ? String(repository.id) : 'unknown',
      },
    });
    const currentRepositoryState = deployment?.features?.repositoryActions?.getCurrentRepositoryState
      ? await deployment.features.repositoryActions.getCurrentRepositoryState(providers, repository)
      : null;
    switch (action) {
      case RepositoryChangeAction.Archive: {
        await repository.archive();
        break;
      }
      case RepositoryChangeAction.UnArchive: {
        await repository.unarchive();
        break;
      }
      case RepositoryChangeAction.Privatize: {
        await repository.update({
          visibility: GitHubRepositoryVisibility.Private,
        });
        break;
      }
      default: {
        return next(CreateError.InvalidParameters('Invalid action'));
      }
    }
    if (deployment?.features?.repositoryActions?.sendActionReceipt) {
      deployment.features.repositoryActions
        .sendActionReceipt(providers, activeContext, repository, localAction, currentRepositoryState)
        .then((ok) => {})
        .catch(() => {});
    }
    insights?.trackMetric({
      name: `${insightsPrefix}s`,
      value: 1,
    });
    insights?.trackEvent({
      name: `${insightsPrefix}Success`,
      properties: {
        requestedById: corporateId,
        repoName: repository.name,
        orgName: repository.organization.name,
        repoId: repository.id ? String(repository.id) : 'unknown',
      },
    });
    // Update the details without background cache so the next fetch is fresh
    try {
      await repository.getDetails(NoCacheNoBackground);
    } catch (ignore) {
      insights?.trackException({ exception: ignore });
    }
    return res.json({
      message: `You ${completedPhrase}: ${repository.full_name}`,
      requiresApproval: false,
    });
  } catch (error) {
    insights?.trackException({ exception: error });
    insights?.trackEvent({
      name: `${insightsPrefix}Failed`,
      properties: {
        requestedById: corporateId,
        repoName: repository.name,
        orgName: repository.organization.name,
        repoId: repository.id ? String(repository.id) : 'unknown',
      },
    });
    return next(error);
  }
}

router.delete(
  '/',
  AddRepositoryPermissionsToRequest,
  async function (req: RequestWithRepo, res: Response, next: NextFunction) {
    // NOTE: duplicated code from /routes/org/repos.ts
    const providers = getProviders(req);
    const { insights } = req;
    const insightsPrefix = 'DeleteRepo';
    const activeContext = (req.individualContext || req.apiContext) as IndividualContext;
    const { organization, repository } = req;
    const repoPermissions = getContextualRepositoryPermissions(req);
    const deletePermissionCheck = checkDeletePermission(repoPermissions);
    if (deletePermissionCheck.allowed) {
      if (deletePermissionCheck.requiresApproval) {
        // Use the company-specific approval workflow
        if (!deployment?.features?.repositoryActions?.submitActionForApproval) {
          return next(
            CreateError.FeatureNotEnabled(
              'This action requires approval but the approval workflow is not configured.'
            )
          );
        }
        const justification = req.body?.justification || 'No justification provided';
        try {
          const result = await deployment.features.repositoryActions.submitActionForApproval(
            providers,
            activeContext,
            repository,
            LocalApiRepoAction.Delete,
            justification
          );
          if (result.error) {
            return next(CreateError.InvalidParameters(result.error));
          }
          return res.json(result) as unknown as void;
        } catch (approvalError) {
          return next(CreateError.ServerError(approvalError.message, approvalError));
        }
      }
      try {
        insights?.trackEvent({
          name: `${insightsPrefix}Started`,
          properties: {
            requestedById: activeContext.link.corporateId,
            repoName: repository.name,
            orgName: repository.organization.name,
            repoId: repository.id ? String(repository.id) : 'unknown',
          },
        });
        const currentRepositoryState = deployment?.features?.repositoryActions?.getCurrentRepositoryState
          ? await deployment.features.repositoryActions.getCurrentRepositoryState(providers, repository)
          : null;
        await repository.delete();
        if (deployment?.features?.repositoryActions?.sendActionReceipt) {
          deployment.features.repositoryActions
            .sendActionReceipt(
              providers,
              activeContext,
              repository,
              LocalApiRepoAction.Delete,
              currentRepositoryState
            )
            .then((ok) => {})
            .catch(() => {});
        }
        insights?.trackMetric({
          name: `${insightsPrefix}s`,
          value: 1,
        });
        insights?.trackEvent({
          name: `${insightsPrefix}Success`,
          properties: {
            requestedById: activeContext.link.corporateId,
            repoName: repository.name,
            orgName: repository.organization.name,
            repoId: repository.id ? String(repository.id) : 'unknown',
          },
        });
        return res.json({
          requiresApproval: false,
          requestSubmitted: false,
          message: `You deleted: ${repository.full_name}`,
        }) as unknown as void;
      } catch (error) {
        insights?.trackException({ exception: error });
        insights?.trackEvent({
          name: `${insightsPrefix}Failed`,
          properties: {
            requestedById: activeContext.link.corporateId,
            repoName: repository.name,
            orgName: repository.organization.name,
            repoId: repository.id ? String(repository.id) : 'unknown',
          },
        });
        return next(error);
      }
    }
    if (!organization.isNewRepositoryLockdownSystemEnabled) {
      return next(CreateError.InvalidParameters('This endpoint is not available as configured in this app.'));
    }
    const daysAfterCreateToAllowSelfDelete = 21; // could be a config setting if anyone cares
    try {
      // make sure ID is known
      if (await repository.isDeleted()) {
        return next(CreateError.NotFound('The repository has already been deleted'));
      }
      const metadata = await repository.getRepositoryMetadata();
      await NewRepositoryLockdownSystem.Statics.ValidateUserCanSelfDeleteRepository(
        repository,
        metadata,
        activeContext,
        daysAfterCreateToAllowSelfDelete
      );
    } catch (noExistingMetadata) {
      if (noExistingMetadata.status === 404) {
        return next(
          CreateError.InvalidParameters(
            'This repository does not have any metadata available regarding who can setup it up. No further actions available.'
          )
        );
      }
      return next(CreateError.NotFound(noExistingMetadata.message, noExistingMetadata));
    }
    const { operations } = getProviders(req);
    const repositoryMetadataProvider = getRepositoryMetadataProvider(operations);
    const lockdownSystem = new NewRepositoryLockdownSystem({
      insights,
      operations,
      organization,
      repository,
      repositoryMetadataProvider,
    });
    await lockdownSystem.deleteLockedRepository(
      false /* delete for any reason */,
      true /* deleted by the original user instead of ops */
    );
    return res.json({
      requiresApproval: false,
      requestSubmitted: false,
      message: `You deleted your repo, ${repository.full_name}.`,
    }) as unknown as void;
  }
);

router.use('/*splat', (req, res: Response, next: NextFunction) => {
  console.warn(req.baseUrl);
  return next(CreateError.NotFound('no API or function available within this specific repo'));
});

export default router;
