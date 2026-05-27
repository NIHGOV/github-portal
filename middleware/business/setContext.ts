//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { NextFunction, Response } from 'express';

import {
  IndividualContext,
  IIndividualContextOptions,
  IWebContextOptions,
  WebContext,
  SessionUserProperties,
  WebApiContext,
} from '../../business/user/index.js';
import { getProviders } from '../../lib/transitional.js';

import type { ReposApiRequest, ReposAppRequest } from '../../interfaces/index.js';

export function webContextMiddleware(req: ReposAppRequest, res: Response, next: NextFunction) {
  const { operations, genericInsights } = getProviders(req);
  const requestInsights = req.insights || genericInsights;
  if (req.apiContext) {
    const msg = 'INVALID: API and web contexts should not be mixed';
    console.warn(msg);
    return next(new Error(msg));
  }
  if (req.individualContext) {
    console.warn('DUPLICATE EFFORT: middleware has already created the individual context');
    return next();
  }
  const webContextOptions: IWebContextOptions = {
    baseUrl: '/',
    request: req,
    response: res,
    // LATER: session provider
    // LATER: settings
    sessionUserProperties: new SessionUserProperties(req.user),
  };
  const webContext = new WebContext(webContextOptions);
  const options: IIndividualContextOptions = {
    corporateIdentity: null,
    link: null,
    insights: requestInsights,
    operations,
    webApiContext: null,
    webContext,
  };
  const individualContext = new IndividualContext(options);
  req.individualContext = individualContext;
  return next();
}

export function apiContextMiddleware(req: ReposApiRequest, res: Response, next: NextFunction) {
  const { genericInsights } = getProviders(req);
  const requestInsights = req.insights || genericInsights;
  const { operations } = getProviders(req);
  if (req.individualContext) {
    const msg = 'INVALID: API and web contexts should not be mixed';
    console.warn(msg);
    return next(new Error(msg));
  }
  const webApiContext = new WebApiContext();
  // when using an authenticated session, provide a web context for session-based features
  let webContext: WebContext | null = null;
  if ((req as any).isAuthenticated?.() && (req as any).session) {
    const webContextOptions: IWebContextOptions = {
      baseUrl: '/',
      request: req as unknown as ReposAppRequest,
      response: res,
      sessionUserProperties: new SessionUserProperties((req as any).user),
    };
    webContext = new WebContext(webContextOptions);
  }
  const options: IIndividualContextOptions = {
    corporateIdentity: null,
    link: null,
    insights: requestInsights,
    operations,
    webApiContext,
    webContext,
  };
  const individualContext = new IndividualContext(options);
  req.apiContext = individualContext;
  return next();
}
