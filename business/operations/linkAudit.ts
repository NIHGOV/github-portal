//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

// Shared, read-only comparison between the Redis-cached bulk links snapshot the Org People view
// reads (operations.getLinks()) and a direct Postgres read (linkProvider.getAll()), used by both
// scripts/linkAudit.ts (CLI/job) and the /administration/link-audit report route.

import { NoCacheNoBackground, type ICorporateLink, type IProviders } from '../../interfaces/index.js';
import type { OrganizationMember } from '../organizationMember.js';

export type LinkAuditRowStatus =
  'stale-cache' | 'orphaned-cache' | 'linked-no-corporate-username' | 'cache-identity-mismatch';

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
  // Pre-fetched cached links snapshot to compare against, in place of a fresh operations.getLinks()
  // call. Callers that want this to match a specific process's People-view responses exactly
  // (which read through an additional 5-minute local cache -- see api/client/leakyLocalCache.ts's
  // getLinksLightCache()) should fetch it that same way and pass it here.
  cachedLinksOverride?: ICorporateLink[];
  // Per-org member list source to use instead of a plain organization.getMembers() call, e.g.
  // api/client/organization/people.ts's getOrganizationMembersLightCache() so this matches the
  // exact snapshot the People API is currently serving for that org. Ignored when forceFreshMembers
  // is true (that always fetches live, uncached, for both this and the People API).
  getMembersOverride?: (orgName: string) => Promise<OrganizationMember[]>;
}

export async function auditLinks(
  providers: IProviders,
  orgNames: string[],
  options?: ILinkAuditOptions
): Promise<ILinkAuditResult> {
  const forceFreshMembers = options?.forceFreshMembers !== false;
  const { operations, linkProvider } = providers;

  const cachedLinks = options?.cachedLinksOverride ?? (await operations.getLinks());
  const cachedByThirdPartyId = toMapByThirdPartyId(cachedLinks);

  const freshLinks = await linkProvider.getAll();
  const freshByThirdPartyId = toMapByThirdPartyId(freshLinks);

  const rows: ILinkAuditRow[] = [];

  for (const orgName of orgNames) {
    const organization = operations.getOrganization(orgName);
    const members = forceFreshMembers
      ? await organization.getMembers(NoCacheNoBackground)
      : await (options?.getMembersOverride?.(orgName) ?? organization.getMembers());

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
      } else if (cached && fresh && !cached.corporateUsername) {
        // Status reflects what the People view actually renders, which reads the cached link --
        // not `fresh`, which can disagree with cache in either direction on this field alone.
        row = {
          organization: orgName,
          login: member.login,
          githubId,
          status: 'linked-no-corporate-username',
          corporateId: cached.corporateId,
          corporateTenantId: cached.corporateTenantId,
        };
      } else if (
        cached &&
        fresh &&
        (normalizeForComparison(cached.corporateId) !== normalizeForComparison(fresh.corporateId) ||
          normalizeForComparison(cached.corporateUsername) !==
            normalizeForComparison(fresh.corporateUsername) ||
          normalizeForComparison(cached.corporateTenantId) !==
            normalizeForComparison(fresh.corporateTenantId))
      ) {
        // Both exist and have a corporateUsername, but disagree on identity -- e.g. a relink or a
        // tenant change that the cache hasn't picked up yet. Report the live (Postgres) values,
        // since those are what's actually true; the cached ones are what the view currently shows.
        row = {
          organization: orgName,
          login: member.login,
          githubId,
          status: 'cache-identity-mismatch',
          corporateId: fresh.corporateId,
          corporateUsername: fresh.corporateUsername,
          corporateTenantId: fresh.corporateTenantId,
        };
      }
      if (row) {
        recordRowTelemetry(providers, row, fresh);
        rows.push(row);
      }
    }
  }

  return { rows, cachedLinkCount: cachedLinks.length, freshLinkCount: freshLinks.length };
}

// A discrepancy can only be validated when a live (Postgres) row exists and has a recorded
// tenant -- that's the actual source of truth. `orphaned-cache` has no live row at all, which
// isn't ambiguous (just cache lag), and the reported `corporateTenantId` on a row can reflect the
// cached side, which can disagree with the live side on this field just like any other.
function recordRowTelemetry(providers: IProviders, row: ILinkAuditRow, liveLink?: ICorporateLink): void {
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
  const canBeValidated = !liveLink || !!liveLink.corporateTenantId;
  if (!canBeValidated) {
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

// A field absent on a cached link (rehydrated as `undefined`, e.g. for links created before it
// existed) and the same field genuinely `null` on a fresh Postgres row both mean "no value" --
// without this, every such link would be reported as a cache-identity-mismatch forever.
function normalizeForComparison(value: string | null | undefined): string {
  return value || '';
}
