//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

// Read-only diagnostic: for one or more GitHub orgs, compares each member's linked status as the
// People view would compute it (operations.getLinks(), the Redis-cached bulk snapshot keyed by
// thirdpartyid) against a direct, uncached Postgres read (linkProvider.getAll()). Surfaces any
// member whose link row exists in Postgres but is missing from the cached snapshot (would show as
// "Not linked" in the Org People view despite a real `links` row -- see PLAN.md's notes on
// cross-tenant/MTO corporate identities), plus members who are linked but have no corporateUsername
// (shown as "unknown account" rather than a fully recognized corporate identity).
//
// Nothing is written anywhere; this only reads via operations.getLinks() and linkProvider.getAll().
// Also available as a self-service report at /administration/link-audit (see routes/administration).
//
// Required env var:
//   LINK_AUDIT_GITHUB_ORGS   comma-separated GitHub org names to scan
// Optional env var:
//   LINK_AUDIT_FRESH_MEMBERS   set to '0' to allow the normal org-member cache (faster, may itself
//                              be stale); defaults to forcing a live GitHub member list per org

import job from '../job.js';
import { IProviders } from '../interfaces/index.js';
import { auditLinks } from '../business/operations/linkAudit.js';

job.run(linkAudit, { name: 'Link audit' });

async function linkAudit(providers: IProviders): Promise<void> {
  const orgNames = requireEnv('LINK_AUDIT_GITHUB_ORGS')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const forceFreshMembers = process.env.LINK_AUDIT_FRESH_MEMBERS !== '0';

  console.log('Fetching cached links snapshot (operations.getLinks(), what the People view uses)...');
  console.log('Fetching live links from Postgres (linkProvider.getAll(), bypasses the Redis cache)...');
  for (const orgName of orgNames) {
    console.log(`Scanning organization: ${orgName}`);
  }

  const { rows, cachedLinkCount, freshLinkCount } = await auditLinks(providers, orgNames, {
    forceFreshMembers,
  });

  console.log(`Cached snapshot: ${cachedLinkCount} link(s). Live table: ${freshLinkCount} link(s).`);
  console.log('');

  if (rows.length === 0) {
    console.log('No discrepancies found: every linked member matches between the cache and Postgres.');
    return;
  }
  console.log(`Found ${rows.length} discrepancy/discrepancies:`);
  console.log('');
  for (const row of rows) {
    console.log(
      `[${row.status}] org=${row.organization} login=${row.login} githubId=${row.githubId}` +
        (row.corporateId ? ` corporateId=${row.corporateId}` : '') +
        (row.corporateUsername ? ` corporateUsername=${row.corporateUsername}` : '')
    );
  }
  console.log('');
  console.log(
    'stale-cache: a `links` row exists in Postgres but was missing from the cached bulk snapshot the ' +
      'Org People view reads -- reload the People page (the 30s Redis cache should self-heal) and re-run ' +
      'this audit; if it never clears, the row is real but the cache/background-refresh is stuck.'
  );
  console.log(
    'orphaned-cache: the cached snapshot has a link the live table does not -- likely just unlinked ' +
      'moments ago; re-run to confirm it clears.'
  );
  console.log(
    'linked-no-corporate-username: a real, current `links` row with no corporateUsername -- shows as ' +
      '"unknown account" rather than a recognized corporate identity in the People view.'
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}
