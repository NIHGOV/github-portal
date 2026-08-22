//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

// "Gather" step of the generic corporate-identity tenant migration toolkit (see
// PLAN.md > "Corporate Identity Tenant Migration Ledger"). Scans one or more GitHub
// organizations' members and, for those already linked, flags candidates by simple substring
// criteria against their *currently stored* corporate identity: UPN/email contains, display name
// contains, or org membership alone. Every candidate is upserted into the `identitytenantmigrations`
// ledger table (for durability/audit/re-run safety) AND printed to stdout as a single JSON array,
// delimited by BEGIN/END marker lines, so a wrapping CI job can capture it into a file the
// developer can download, fill in with the new tenant's identity, and feed back into
// setTargets.ts. This is read-only with respect to `links`; it only ever writes to the ledger.
//
// Required env vars:
//   TENANT_MIGRATION_BATCH_ID              label for this migration effort, e.g. "<source-tenant>-to-<target-tenant>-2026-08"
//   TENANT_MIGRATION_GITHUB_ORGS           comma-separated GitHub org names to scan
// Optional (at least one recommended, otherwise every linked org member is a candidate):
//   TENANT_MIGRATION_UPN_CONTAINS          substring match (case-insensitive) against the stored
//                                          corporate UPN/email -- e.g. the source tenant's domain
//   TENANT_MIGRATION_DISPLAY_NAME_CONTAINS substring match (case-insensitive) against the stored
//                                          corporate display name
//   TENANT_MIGRATION_EXCLUDE_UPN_CONTAINS  substring match (case-insensitive) against the stored
//                                          corporate UPN/email that marks a member as already
//                                          migrated -- e.g. the target tenant's domain -- excluded
//                                          from the output and marked "skipped-already-migrated"

export const JSON_BEGIN_MARKER = '===TENANT_MIGRATION_CANDIDATES_JSON_BEGIN===';
export const JSON_END_MARKER = '===TENANT_MIGRATION_CANDIDATES_JSON_END===';

import job from '../../job.js';
import { IProviders } from '../../interfaces/index.js';
import { ensureSchema, upsertCandidate, TenantMigrationStatus } from './ledger.js';

job.run(findCandidates, { name: 'Tenant migration: gather candidates' });

async function findCandidates(providers: IProviders): Promise<void> {
  const batchId = requireEnv('TENANT_MIGRATION_BATCH_ID');
  const orgNames = requireEnv('TENANT_MIGRATION_GITHUB_ORGS')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const upnContains = lowerOrUndefined(process.env.TENANT_MIGRATION_UPN_CONTAINS);
  const displayNameContains = lowerOrUndefined(process.env.TENANT_MIGRATION_DISPLAY_NAME_CONTAINS);
  const excludeUpnContains = lowerOrUndefined(process.env.TENANT_MIGRATION_EXCLUDE_UPN_CONTAINS);

  const pool = providers.postgresPool;
  await ensureSchema(pool);

  const { operations } = providers;
  const counts: Record<TenantMigrationStatus, number> = {
    pending: 0,
    'needs-review': 0,
    'skipped-already-migrated': 0,
    ready: 0,
    applied: 0,
    conflict: 0,
    failed: 0,
  };
  let unlinkedCount = 0;
  const outputRows: unknown[] = [];

  for (const orgName of orgNames) {
    console.log(`Scanning organization: ${orgName}`);
    const organization = operations.getOrganization(orgName);
    const pairs = await organization.getUnlinkedAndLinkedMembers();

    for (const pair of pairs) {
      if (!pair.link) {
        unlinkedCount++;
        continue;
      }
      const corporateUsername = pair.link.corporateUsername || '';
      const corporateMailAddress = pair.link.corporateMailAddress || '';
      const corporateDisplayName = pair.link.corporateDisplayName || '';
      const upnHaystack = `${corporateUsername} ${corporateMailAddress}`.toLowerCase();
      const displayNameHaystack = corporateDisplayName.toLowerCase();

      let status: TenantMigrationStatus | 'out-of-scope';
      if (excludeUpnContains && upnHaystack.includes(excludeUpnContains)) {
        status = 'skipped-already-migrated';
      } else if (!upnContains && !displayNameContains) {
        // No content filter given -- org membership alone is the criterion.
        status = 'pending';
      } else if (
        (upnContains && upnHaystack.includes(upnContains)) ||
        (displayNameContains && displayNameHaystack.includes(displayNameContains))
      ) {
        status = 'pending';
      } else {
        status = 'out-of-scope';
      }

      if (status === 'out-of-scope') {
        continue;
      }

      await upsertCandidate(pool, batchId, {
        thirdPartyId: pair.link.thirdPartyId,
        thirdPartyUsername: pair.member.login,
        discoveredCorporateId: pair.link.corporateId,
        discoveredCorporateUsername: corporateUsername,
        discoveredCorporateDisplayName: corporateDisplayName,
        discoveredCorporateMailAddress: corporateMailAddress,
        status,
      });
      counts[status]++;

      if (status === 'pending') {
        outputRows.push({
          thirdPartyUsername: pair.member.login,
          organization: orgName,
          discoveredCorporateId: pair.link.corporateId,
          discoveredCorporateUsername: corporateUsername,
          discoveredCorporateDisplayName: corporateDisplayName,
          discoveredCorporateMailAddress: corporateMailAddress,
          // Fill these in, then feed the whole file into setTargets.ts. Leave a row's
          // newCorporateId blank to skip migrating that person.
          newCorporateId: '',
          newCorporateUsername: '',
          newCorporateDisplayName: '',
          newCorporateMailAddress: '',
          sourceTenantLabel: '',
          targetTenantLabel: '',
        });
      }
    }
  }

  console.log('');
  console.log(`Batch: ${batchId}`);
  console.log('Ledger summary (see identitytenantmigrations table):');
  console.log(`  pending (candidates):     ${counts.pending}`);
  console.log(`  skipped-already-migrated: ${counts['skipped-already-migrated']}`);
  console.log(`  unlinked (out of scope):  ${unlinkedCount}`);
  console.log('');
  console.log(`Candidates file (${outputRows.length} row(s)) follows -- fill in the blank`);
  console.log('new* fields for each person you want to migrate, then feed this file into');
  console.log('setTargets.ts / the "patch" workflow mode:');
  console.log(JSON_BEGIN_MARKER);
  console.log(JSON.stringify(outputRows, null, 2));
  console.log(JSON_END_MARKER);
}

function lowerOrUndefined(value: string | undefined): string | undefined {
  return value ? value.toLowerCase() : undefined;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}
