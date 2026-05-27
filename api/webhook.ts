//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { NextFunction, Response, Router } from 'express';
import moment from 'moment';

import { CreateError, getProviders, isWebhookIngestionEndpointEnabled } from '../lib/transitional.js';
import {
  normalizeWebhookRawBody,
  requireWebhookRawBody,
  validateWebhookSignature,
} from '../lib/webhookSignature.js';

import OrganizationWebhookProcessor from '../business/webhooks/organizationProcessor.js';

import type { ReposAppRequest } from '../interfaces/index.js';

// This is a reference implementation but not heavily exercised as we use
// Service Bus internally with a different set of technologies and patterns.
// See the root README.md for more info.

const router: Router = Router();

interface IRequestWithRaw extends ReposAppRequest {
  _raw?: string | Buffer;
}

router.use(async (req: IRequestWithRaw, res: Response, next: NextFunction) => {
  const { insights } = req;
  if (!isWebhookIngestionEndpointEnabled(req)) {
    return next(
      CreateError.NotAuthenticated(
        'This feature is currently disabled. Only queue-based firehose ingestion will work at this time.'
      )
    );
  }

  const providers = getProviders(req);
  const webhooksConfig = providers.config?.github?.webhooks;
  const { operations } = providers;
  const body = req.body;
  const orgName = body && body.organization && body.organization.login ? body.organization.login : null;
  if (!orgName) {
    return next(CreateError.InvalidParameters('No organization login in the body'));
  }
  try {
    if (!req.organization) {
      req.organization = operations.getOrganization(orgName);
    }
  } catch (noOrganization) {
    return next(new Error('This API endpoint is not configured for the provided organization name.'));
  }
  const signature256 = req.headers['x-hub-signature-256'] as string;
  const properties = {
    delivery: req.headers['x-github-delivery'] as string,
    event: req.headers['x-github-event'] as string,
    signature: signature256 || (req.headers['x-hub-signature'] as string),
    started: moment().utc().format(),
  };
  if (!properties.delivery || !properties.event) {
    return next(CreateError.InvalidParameters('Missing X-GitHub-Delivery and/or X-GitHub-Event'));
  }
  let rawBody: string;
  try {
    rawBody = normalizeWebhookRawBody(requireWebhookRawBody(req._raw, 'HTTP webhook raw body'));
  } catch (rawBodyError) {
    return next(CreateError.InvalidParameters(rawBodyError.message, rawBodyError));
  }
  const signatureResult = validateWebhookSignature({
    signature: signature256,
    rawBody,
    secret: webhooksConfig?.sharedSecret,
    allowInvalidSignature: webhooksConfig?.allowInvalidSignature === true,
    acceptUnsigned: webhooksConfig?.acceptUnsigned === true,
  });
  if (signatureResult.outcome === 'missing' && !signatureResult.proceed) {
    return next(CreateError.NotAuthenticated('Missing or unconfigured X-Hub-Signature-256'));
  }
  if (signatureResult.outcome === 'invalid' && !signatureResult.proceed) {
    return next(CreateError.NotAuthenticated('Invalid X-Hub-Signature-256'));
  }
  const event = {
    properties: properties,
    body: req.body,
    rawBody,
  };
  const options = {
    providers,
    insights,
    organization: req.organization,
    event,
  };
  let error = null;
  let result = null;
  try {
    result = await OrganizationWebhookProcessor(options);
  } catch (hookError) {
    error = hookError;
  }
  const obj = error || result;
  const statusCode = obj.statusCode || obj.status || (error ? 400 : 200);
  if (error) {
    return next(CreateError.CreateStatusCodeError(statusCode, error.message, error));
  }
  res.status(statusCode);
  res.json(result);
});

export default router;
