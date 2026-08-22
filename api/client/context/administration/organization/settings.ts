//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { NextFunction, Response, Router } from 'express';

import { OrganizationSetting } from '../../../../../business/entities/organizationSettings/organizationSetting.js';
import { ReposAppRequest } from '../../../../../interfaces/index.js';
import { CreateError, ErrorHelper, getProviders } from '../../../../../lib/transitional.js';
import { stringParam } from '../../../../../lib/utils.js';

const router: Router = Router();

interface IOrganizationSettings extends ReposAppRequest {
  dynamicSettings: OrganizationSetting;
}

router.use(async (req: IOrganizationSettings, res: Response, next: NextFunction) => {
  const { organization } = req;
  const { organizationSettingsProvider } = getProviders(req);
  try {
    const dynamicSettings = await organizationSettingsProvider.getOrganizationSetting(
      String(organization.id)
    );
    req.dynamicSettings = dynamicSettings;
  } catch (error) {
    console.warn(error);
  }
  return next();
});

router.get('/', async (req: IOrganizationSettings, res: Response, next: NextFunction) => {
  const { dynamicSettings } = req;
  return res.json({
    dynamicSettings,
  }) as unknown as void;
});

router.delete('/', async function (req: IOrganizationSettings, res: Response) {
  const { dynamicSettings } = req;
  const { organizationId } = dynamicSettings;
  const { organizationSettingsProvider, queryCache } = getProviders(req);
  const orgName = req.query.deleteOrganizationConfiguration as string;
  if (orgName?.toLowerCase() !== dynamicSettings.organizationName.toLowerCase()) {
    throw CreateError.InvalidParameters(
      'The organization name provided does not match the organization name in the configuration.'
    );
  }
  await organizationSettingsProvider.deleteOrganizationSetting(dynamicSettings);
  res.status(204);
  if (queryCache) {
    queryCache.removeOrganizationById(String(organizationId));
  }
  return res.end() as unknown as void;
});

// -- features

router.get('/features', async (req: IOrganizationSettings, res: Response, next: NextFunction) => {
  const { dynamicSettings, organization } = req;
  const { features } = dynamicSettings;
  return res.json({
    features,
    organizationName: organization.name,
  }) as unknown as void;
});

router.get('/feature/:flag', async (req: IOrganizationSettings, res: Response, next: NextFunction) => {
  const { dynamicSettings, organization } = req;
  const flag = stringParam(req, 'flag');
  return res.json({
    flag,
    value: dynamicSettings.features.includes(flag) ? flag : null,
    organizationName: organization.name,
  }) as unknown as void;
});

router.put('/feature/:flag', async (req: IOrganizationSettings, res: Response, next: NextFunction) => {
  const { dynamicSettings, organization } = req;
  const { organizationSettingsProvider } = getProviders(req);
  const { insights } = req;
  const { features } = dynamicSettings;
  const flag = stringParam(req, 'flag');
  const restart = req.query.restart === '1';
  insights?.trackEvent({
    name: 'AddOrganizationFeatureFlag',
    properties: {
      flag,
      restart,
      currentFeatureFlags: features.join(', '),
    },
  });
  // special case
  if (flag === 'active') {
    if (dynamicSettings.active) {
      return next(CreateError.InvalidParameters('The organization is already active.'));
    }
    dynamicSettings.active = true;
  } else {
    if (features.includes(flag)) {
      return next(CreateError.InvalidParameters(`flag "${flag}" is already set`));
    }
    dynamicSettings.features.push(flag);
  }
  try {
    if (restart) {
      dynamicSettings.updated = new Date();
    }
    await organizationSettingsProvider.updateOrganizationSetting(dynamicSettings);
  } catch (error) {
    return next(
      CreateError.CreateStatusCodeError(
        ErrorHelper.GetStatus(error) || 400,
        `error adding flag "${flag}": ${error}`
      )
    );
  }
  return res.json({
    flag,
    value: dynamicSettings.features.includes(flag) ? flag : null,
    restart,
    organizationName: organization.name,
  }) as unknown as void;
});

router.delete('/feature/:flag', async (req: IOrganizationSettings, res: Response, next: NextFunction) => {
  const { organization, dynamicSettings } = req;
  const { organizationSettingsProvider } = getProviders(req);
  const { insights } = req;
  const { features } = dynamicSettings;
  const flag = stringParam(req, 'flag');
  const restart = req.query.restart === '1';
  insights?.trackEvent({
    name: 'RemoveOrganizationFeatureFlag',
    properties: {
      flag,
      restart,
      currentFeatureFlags: features.join(', '),
    },
  });
  if (flag === 'active') {
    if (!dynamicSettings.active) {
      return next(CreateError.InvalidParameters('The organization is already inactive.'));
    }
    dynamicSettings.active = false;
  } else {
    if (!features.includes(flag)) {
      return next(CreateError.InvalidParameters(`flag "${flag}" is not set`));
    }
    dynamicSettings.features = dynamicSettings.features.filter((flagEntry) => flagEntry !== flag);
  }
  try {
    if (restart) {
      dynamicSettings.updated = new Date();
    }
    await organizationSettingsProvider.updateOrganizationSetting(dynamicSettings);
  } catch (error) {
    return next(
      CreateError.CreateStatusCodeError(
        ErrorHelper.GetStatus(error) || 400,
        `error removing flag "${flag}": ${error}`
      )
    );
  }
  return res.json({
    flag,
    value: dynamicSettings.features.includes(flag) ? flag : null,
    restart,
    organizationName: organization.name,
  }) as unknown as void;
});

// -- properties

router.get('/properties', async (req: IOrganizationSettings, res: Response, next: NextFunction) => {
  const { dynamicSettings, organization } = req;
  const { properties } = dynamicSettings;
  return res.json({
    properties,
    organizationName: organization.name,
  }) as unknown as void;
});

router.get('/property/:flag', async (req: IOrganizationSettings, res: Response, next: NextFunction) => {
  const { dynamicSettings, organization } = req;
  const propertyName = stringParam(req, 'flag');
  const { properties } = dynamicSettings;
  return res.json({
    property: propertyName,
    value: properties[propertyName] || null,
    organizationName: organization.name,
  }) as unknown as void;
});

router.put(
  '/property/:propertyName',
  async (req: IOrganizationSettings, res: Response, next: NextFunction) => {
    const { organization, dynamicSettings, insights } = req;
    const { organizationSettingsProvider } = getProviders(req);
    const { properties } = dynamicSettings;
    const newValue = req.body.value as string;
    const restart = req.query.restart === '1';
    if (!newValue) {
      return next(CreateError.InvalidParameters('body.value required'));
    }
    if (typeof newValue !== 'string') {
      return next(CreateError.InvalidParameters('body.value must be a string value'));
    }
    const propertyName = stringParam(req, 'propertyName');
    const currentPropertyValue = properties[propertyName] || null;
    insights?.trackEvent({
      name: 'SetOrganizationSettingProperty',
      properties: {
        propertyName,
        restart,
        currentProperties: JSON.stringify(properties),
        currentPropertyValue,
      },
    });
    const updateDescription = `Changing property ${propertyName} value from "${currentPropertyValue}" to "${newValue}"`;
    dynamicSettings.properties[propertyName] = newValue;
    try {
      if (restart) {
        dynamicSettings.updated = new Date();
      }
      await organizationSettingsProvider.updateOrganizationSetting(dynamicSettings);
    } catch (error) {
      return next(
        CreateError.CreateStatusCodeError(
          ErrorHelper.GetStatus(error) || 400,
          `error setting property "${propertyName}" to "${newValue}": ${error}`
        )
      );
    }
    return res.json({
      property: propertyName,
      value: properties[propertyName] || null,
      organizationName: organization.name,
      dynamicSettings,
      restart,
      updateDescription,
    }) as unknown as void;
  }
);

router.delete(
  '/property/:propertyName',
  async (req: IOrganizationSettings, res: Response, next: NextFunction) => {
    const { organization, dynamicSettings, insights } = req;
    const { organizationSettingsProvider } = getProviders(req);
    const { properties } = dynamicSettings;
    const propertyName = stringParam(req, 'propertyName');
    const currentPropertyValue = properties[propertyName] || null;
    const restart = req.query.restart === '1';
    insights?.trackEvent({
      name: 'RemoveOrganizationSettingProperty',
      properties: {
        propertyName,
        currentProperties: JSON.stringify(properties),
        currentPropertyValue,
        restart,
      },
    });
    if (properties[propertyName] === undefined) {
      return next(CreateError.InvalidParameters(`property "${propertyName}" is not set`));
    }
    delete dynamicSettings.properties[propertyName];
    try {
      if (restart) {
        dynamicSettings.updated = new Date();
      }
      await organizationSettingsProvider.updateOrganizationSetting(dynamicSettings);
    } catch (error) {
      return next(
        CreateError.CreateStatusCodeError(
          ErrorHelper.GetStatus(error) || 400,
          `error removing property "${propertyName}": ${error}`
        )
      );
    }
    return res.json({
      property: propertyName,
      value: properties[propertyName] || null,
      organizationName: organization.name,
      restart,
    }) as unknown as void;
  }
);

//

router.use('/*splat', (req, res: Response, next: NextFunction) => {
  return next(CreateError.NotFound('no API or function available in administration - organization'));
});

export default router;
