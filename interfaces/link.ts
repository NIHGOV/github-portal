//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

export interface ICorporateLinkProperties {
  isServiceAccount: any;
  serviceAccountMail: any;

  corporateId: any;
  corporateUsername: any;
  corporateDisplayName: any;
  corporateMailAddress: any;
  // The Entra tenant ID the corporate identity authenticated from, captured at link time so a
  // link's originating tenant can be validated/reported on later without a Graph lookup.
  corporateTenantId?: any;

  thirdPartyId: any;
  thirdPartyUsername: any;
  thirdPartyAvatar: any;
}

export interface ICorporateLink extends ICorporateLinkProperties {
  isServiceAccount: boolean;
  serviceAccountMail: string;

  corporateId: string;
  corporateUsername: string;
  corporateDisplayName: string;
  corporateMailAddress: string;
  corporateTenantId?: string;

  thirdPartyId: string;
  thirdPartyUsername: string;
  thirdPartyAvatar: string;
}

export interface ICorporateLinkExtended {
  internal: () => ICorporateLinkExtendedDirectMethods;
}

export interface ICorporateLinkExtendedDirectMethods {
  getDirectEntity: () => any;
}

export interface ICachedEmployeeInformation {
  id: string;
  displayName: string;
  userPrincipalName: string;
  managerId: string;
  managerDisplayName: string;
  managerMail: string;
}
