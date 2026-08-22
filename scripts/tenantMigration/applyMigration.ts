//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

// Stage 3 of the generic corporate-identity tenant migration toolkit (see
// PLAN.md > "Corporate Identity Tenant Migration Ledger"). Applies every "ready" row in a batch:
// re-fetches the live `links` row, checks it still matches what was discovered (guards against
// drift between discovery and apply -- e.g. someone else already touched the row), patches the
// corporate identity fields, and records the before/after snapshot plus outcome back onto the
// ledger row. Safe to re-run: only "ready" rows are considered, and once a row is "applied" it is
// never revisited.
//
// Required env vars:
//   TENANT_MIGRATION_BATCH_ID   must match the batch used in findCandidates.ts / setTargets.ts
// Optional:
//   TENANT_MIGRATION_COMMIT=1   without this, runs as a dry run: prints the diff for every
//                               "ready" row but does not write to `links` or update the ledger

import job from '../../job.js';
import { ICorporateLink, IProviders } from '../../interfaces/index.js';
import { listByStatus, markApplied, markConflict, markFailed } from './ledger.js';

job.run(applyMigration, { name: 'Tenant migration: apply' });

async function applyMigration(providers: IProviders): Promise<void> {
  const batchId = requireEnv('TENANT_MIGRATION_BATCH_ID');
  const commit = process.env.TENANT_MIGRATION_COMMIT === '1';

  const pool = providers.postgresPool;
  const linkProvider = providers.linkProvider;
  const readyRows = await listByStatus(pool, batchId, ['ready']);

  console.log(`Batch: ${batchId}`);
  console.log(`Found ${readyRows.length} "ready" row(s) to apply`);
  console.log(commit ? 'MODE: COMMIT (links table will be written)' : 'MODE: DRY RUN (no writes)');

  let applied = 0;
  let conflicts = 0;
  let failed = 0;

  for (const row of readyRows) {
    const label = `[${row.thirdPartyUsername}]`;
    let link: ICorporateLink;
    try {
      link = await linkProvider.getByThirdPartyUsername(row.thirdPartyUsername);
    } catch (lookupError) {
      const message =
        lookupError?.status === 404 ? 'link no longer exists' : lookupError?.message || String(lookupError);
      console.error(`${label}: FAILED - ${message}`);
      if (commit) {
        await markFailed(pool, row.id, message);
      }
      failed++;
      continue;
    }

    // Guard against drift: someone/something changed this link since discovery.
    if (row.discoveredCorporateId && link.corporateId !== row.discoveredCorporateId) {
      const notes = `live corporateId (${link.corporateId}) no longer matches discovered corporateId (${row.discoveredCorporateId})`;
      console.error(`${label}: CONFLICT - ${notes}`);
      if (commit) {
        await markConflict(pool, row.id, notes);
      }
      conflicts++;
      continue;
    }

    const beforeSnapshot = {
      corporateId: link.corporateId,
      corporateUsername: link.corporateUsername,
      corporateDisplayName: link.corporateDisplayName,
      corporateMailAddress: link.corporateMailAddress,
    };

    link.corporateId = row.newCorporateId;
    link.corporateUsername = row.newCorporateUsername;
    link.corporateMailAddress = row.newCorporateMailAddress || row.newCorporateUsername;
    if (row.newCorporateDisplayName) {
      link.corporateDisplayName = row.newCorporateDisplayName;
    }

    const afterSnapshot = {
      corporateId: link.corporateId,
      corporateUsername: link.corporateUsername,
      corporateDisplayName: link.corporateDisplayName,
      corporateMailAddress: link.corporateMailAddress,
    };

    console.log(`${label}: ${commit ? 'UPDATING' : 'WOULD UPDATE'}`);
    console.log(`  before: ${JSON.stringify(beforeSnapshot)}`);
    console.log(`  after:  ${JSON.stringify(afterSnapshot)}`);

    if (commit) {
      try {
        await linkProvider.updateLink(link);
        await markApplied(pool, row.id, beforeSnapshot, afterSnapshot);
      } catch (updateError) {
        console.error(`${label}: FAILED - ${updateError?.message || updateError}`);
        await markFailed(pool, row.id, updateError?.message || String(updateError));
        failed++;
        continue;
      }
    }
    applied++;
  }

  console.log('');
  console.log('Summary:');
  console.log(`  applied:   ${applied}${commit ? '' : ' (dry run - no writes performed)'}`);
  console.log(`  conflicts: ${conflicts}`);
  console.log(`  failed:    ${failed}`);
  if (!commit && applied > 0) {
    console.log('');
    console.log('Re-run with TENANT_MIGRATION_COMMIT=1 to apply these changes.');
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}
