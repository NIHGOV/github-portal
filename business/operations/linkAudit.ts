//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

// Shared, read-only comparison between the Redis-cached bulk links snapshot the Org People view
// reads (operations.getLinks()) and a direct Postgres read (linkProvider.getAll()), used by both
// scripts/linkAudit.ts (CLI/job) and the /administration/link-audit report route.

import type { ICorporateLink, IProviders } from '../../interfaces/index.js';

export type LinkAuditRowStatus = 'stale-cache' | 'orphaned-cache' | 'linked-no-corporate-username';

export interface ILinkAuditRow {
  organization: string;
  login: string;
  githubId: string;
  status: LinkAuditRowStatus;
  corporateId?: string;
  corporateUsername?: string;
}

export interface ILinkAuditResult {
  rows: ILinkAuditRow[];
  cachedLinkCount: number;
  freshLinkCount: number;
}

export interface ILinkAuditOptions {
  // Forces a live GitHub org member list per org instead of the normal member cache. Defaults to true.
  forceFreshMembers?: boolean;
}

export async function auditLinks(
  providers: IProviders,
  orgNames: string[],
  options?: ILinkAuditOptions
): Promise<ILinkAuditResult> {
  const forceFreshMembers = options?.forceFreshMembers !== false;
  const { operations, linkProvider } = providers;

  const cachedLinks = await operations.getLinks();
  const cachedByThirdPartyId = toMapByThirdPartyId(cachedLinks);

  const freshLinks = await linkProvider.getAll();
  const freshByThirdPartyId = toMapByThirdPartyId(freshLinks);

  const rows: ILinkAuditRow[] = [];

  for (const orgName of orgNames) {
    const organization = operations.getOrganization(orgName);
    const members = await organization.getMembers(
      forceFreshMembers ? { maxAgeSeconds: 0, backgroundRefresh: false } : undefined
    );

    for (const member of members) {
      const githubId = String(member.id);
      const cached = cachedByThirdPartyId.get(githubId);
      const fresh = freshByThirdPartyId.get(githubId);

      if (fresh && !cached) {
        rows.push({
          organization: orgName,
          login: member.login,
          githubId,
          status: 'stale-cache',
          corporateId: fresh.corporateId,
          corporateUsername: fresh.corporateUsername,
        });
      } else if (cached && !fresh) {
        rows.push({
          organization: orgName,
          login: member.login,
          githubId,
          status: 'orphaned-cache',
          corporateId: cached.corporateId,
          corporateUsername: cached.corporateUsername,
        });
      } else if (fresh && !fresh.corporateUsername) {
        rows.push({
          organization: orgName,
          login: member.login,
          githubId,
          status: 'linked-no-corporate-username',
          corporateId: fresh.corporateId,
        });
      }
    }
  }

  return { rows, cachedLinkCount: cachedLinks.length, freshLinkCount: freshLinks.length };
}

function toMapByThirdPartyId(links: ICorporateLink[]): Map<string, ICorporateLink> {
  const map = new Map<string, ICorporateLink>();
  for (const link of links) {
    if (link?.thirdPartyId) {
      map.set(String(link.thirdPartyId), link);
    }
  }
  return map;
}
