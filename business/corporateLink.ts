//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { ICorporateLink } from '../interfaces/index.js';

export const CorporatePropertyNames = [
  'isServiceAccount',
  'serviceAccountMail',

  'corporateId',
  'corporateUsername',
  'corporateDisplayName',
  'corporateMailAddress',
  'corporateTenantId',

  'thirdPartyId',
  'thirdPartyUsername',
  'thirdPartyAvatar',
];

export function corporateLinkToJson(link: ICorporateLink): ICorporateLink {
  return (
    link && {
      corporateDisplayName: link.corporateDisplayName,
      corporateId: link.corporateId,
      corporateMailAddress: link.corporateMailAddress,
      corporateUsername: link.corporateUsername,
      // corporateTenantId intentionally excluded -- this serializer feeds the general people/team/
      // account API responses, not just the admin link-audit report, and the originating Entra
      // tenant is cross-tenant identity metadata that shouldn't be exposed to every caller
      // authorized to view a linked account. The audit route builds its own row projection instead.
      serviceAccountMail: link.serviceAccountMail,
      isServiceAccount: link.isServiceAccount,
      thirdPartyAvatar: link.thirdPartyAvatar,
      thirdPartyId: link.thirdPartyId,
      thirdPartyUsername: link.thirdPartyUsername,
    }
  );
}
