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
import { ITenantMigrationLedgerRow, listByStatus, markApplied, markConflict, markFailed } from './ledger.js';

job.run(applyMigration, { name: 'Tenant migration: apply' });

// Compares a live link against everything discovery recorded (not just corporateId): if the
// username, display name, or mail address drifted while the ID stayed stable, applying would
// silently overwrite those newer live values with the stale `new*` targets set at gather/patch
// time. Returns a human-readable description of the mismatch(es), or null if nothing drifted.
function findDrift(live: ICorporateLink, row: ITenantMigrationLedgerRow): string | null {
  const mismatches: string[] = [];
  if (row.discoveredCorporateId && live.corporateId !== row.discoveredCorporateId) {
    mismatches.push(`corporateId (live: ${live.corporateId}, discovered: ${row.discoveredCorporateId})`);
  }
  if (row.discoveredCorporateUsername && live.corporateUsername !== row.discoveredCorporateUsername) {
    mismatches.push(
      `corporateUsername (live: ${live.corporateUsername}, discovered: ${row.discoveredCorporateUsername})`
    );
  }
  if (
    row.discoveredCorporateDisplayName &&
    live.corporateDisplayName !== row.discoveredCorporateDisplayName
  ) {
    mismatches.push(
      `corporateDisplayName (live: ${live.corporateDisplayName}, discovered: ${row.discoveredCorporateDisplayName})`
    );
  }
  if (
    row.discoveredCorporateMailAddress &&
    live.corporateMailAddress !== row.discoveredCorporateMailAddress
  ) {
    mismatches.push(
      `corporateMailAddress (live: ${live.corporateMailAddress}, discovered: ${row.discoveredCorporateMailAddress})`
    );
  }
  return mismatches.length ? mismatches.join('; ') : null;
}

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
      // Look up by the immutable thirdPartyId, not the mutable username: a GitHub login can be
      // renamed between the gather and apply steps (or the ledger's cached username can simply be
      // stale), which would otherwise cause a false "link no longer exists" failure here.
      link = await linkProvider.getByThirdPartyId(row.thirdPartyId);
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
    const initialDrift = findDrift(link, row);
    if (initialDrift) {
      const notes = `live link no longer matches what was discovered: ${initialDrift}`;
      console.error(`${label}: CONFLICT - ${notes}`);
      if (commit) {
        await markConflict(pool, row.id, notes);
      }
      conflicts++;
      continue;
    }

    // Guard against corrupting the links table's one-corporate-identity-per-link invariant
    // (relied on by e.g. business/operations/core.ts's getLinkWithOverrides): the target identity
    // must not already be attached to a *different* GitHub account. `corporateid` is only
    // non-uniquely indexed (data/pg.sql), so nothing else enforces this.
    const existingLinksForTarget = await linkProvider.queryByCorporateId(row.newCorporateId);
    const conflictingLink = existingLinksForTarget.find(
      (existing) => existing.thirdPartyId !== row.thirdPartyId
    );
    if (conflictingLink) {
      const notes = `newCorporateId (${row.newCorporateId}) is already linked to a different GitHub account (thirdPartyId ${conflictingLink.thirdPartyId})`;
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
        // Re-verify immediately before writing: the drift check above and this write are not one
        // atomic operation, so re-fetching here narrows (though the underlying link providers
        // don't expose a true compare-and-swap update, so it can't fully close) the window in
        // which a concurrent relink/update could otherwise be silently overwritten.
        const liveLink = await linkProvider.getByThirdPartyId(row.thirdPartyId);
        const preWriteDrift = findDrift(liveLink, row);
        if (preWriteDrift) {
          const notes = `live link changed just before the update was applied: ${preWriteDrift}`;
          console.error(`${label}: CONFLICT - ${notes}`);
          await markConflict(pool, row.id, notes);
          conflicts++;
          continue;
        }
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
