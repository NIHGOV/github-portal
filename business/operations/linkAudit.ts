//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

// Shared, read-only comparison between the Redis-cached bulk links snapshot the Org People view
// reads (operations.getLinks()) and a direct Postgres read (linkProvider.getAll()), used by both
// scripts/linkAudit.ts (CLI/job) and the /administration/link-audit report route.

import { NoCacheNoBackground, type ICorporateLink, type IProviders } from '../../interfaces/index.js';

export type LinkAuditRowStatus = 'stale-cache' | 'orphaned-cache' | 'linked-no-corporate-username';

export interface ILinkAuditRow {
  organization: string;
  login: string;
  githubId: string;
  status: LinkAuditRowStatus;
  corporateId?: string;
  corporateUsername?: string;
  // Absent for links created before tenant tracking was added -- see recordRowTelemetry below.
  corporateTenantId?: string;
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
    const members = await organization.getMembers(forceFreshMembers ? NoCacheNoBackground : undefined);

    for (const member of members) {
      const githubId = String(member.id);
      const cached = cachedByThirdPartyId.get(githubId);
      const fresh = freshByThirdPartyId.get(githubId);

      let row: ILinkAuditRow = null;
      if (fresh && !cached) {
        row = {
          organization: orgName,
          login: member.login,
          githubId,
          status: 'stale-cache',
          corporateId: fresh.corporateId,
          corporateUsername: fresh.corporateUsername,
          corporateTenantId: fresh.corporateTenantId,
        };
      } else if (cached && !fresh) {
        row = {
          organization: orgName,
          login: member.login,
          githubId,
          status: 'orphaned-cache',
          corporateId: cached.corporateId,
          corporateUsername: cached.corporateUsername,
          corporateTenantId: cached.corporateTenantId,
        };
      } else if (fresh && !fresh.corporateUsername) {
        row = {
          organization: orgName,
          login: member.login,
          githubId,
          status: 'linked-no-corporate-username',
          corporateId: fresh.corporateId,
          corporateTenantId: fresh.corporateTenantId,
        };
      }
      if (row) {
        recordRowTelemetry(providers, row);
        rows.push(row);
      }
    }
  }

  return { rows, cachedLinkCount: cachedLinks.length, freshLinkCount: freshLinks.length };
}

// A discrepancy on a link with no recorded corporate tenant ID can't be validated at all (we have
// no way to confirm which Entra tenant it belongs to), so it's logged as a breaking issue rather
// than routine cache lag.
function recordRowTelemetry(providers: IProviders, row: ILinkAuditRow): void {
  const insights = providers.genericInsights;
  if (!insights) {
    return;
  }
  const properties = {
    organization: row.organization,
    login: row.login,
    githubId: row.githubId,
    status: row.status,
    corporateId: row.corporateId || '',
    corporateUsername: row.corporateUsername || '',
    corporateTenantId: row.corporateTenantId || '',
  };
  if (!row.corporateTenantId) {
    insights.trackException({
      exception: new Error(
        `Link audit: ${row.status} for ${row.login} (org ${row.organization}) has no recorded corporate tenant ID and cannot be validated`
      ),
      properties,
    });
  } else {
    insights.trackEvent({ name: 'LinkAuditDiscrepancy', properties });
  }
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
