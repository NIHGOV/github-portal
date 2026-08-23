//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

// Second half of the "patch" step of the generic corporate-identity tenant migration toolkit (see
// PLAN.md > "Corporate Identity Tenant Migration Ledger"). Takes the candidates file produced by
// findCandidates.ts (downloaded, then hand-edited by a developer to fill in each person's new
// tenant identity) and fills in the corresponding `identitytenantmigrations` ledger rows for a
// batch, moving them from "pending"/"needs-review" to "ready". Rows left blank (no new* fields
// filled in) are skipped -- that's how a developer opts a candidate out of the migration. Does not
// touch the `links` table -- see applyMigration.ts for that.
//
// Required env vars:
//   TENANT_MIGRATION_BATCH_ID     must match the batch used in findCandidates.ts
// Exactly one of:
//   TENANT_MIGRATION_TARGETS_FILE       path to a JSON file (local/interactive use)
//   TENANT_MIGRATION_TARGETS_JSON_BASE64 the JSON content itself, base64-encoded (for CI use --
//                                        avoids writing a secrets file to disk on a shared runner)
// Both are the same JSON array findCandidates.ts prints, after being edited, with entries shaped like:
//     {
//       "thirdPartyUsername": "octocat",
//       "newCorporateId": "11111111-2222-3333-4444-555555555555",
//       "newCorporateUsername": "jdoe@target-tenant.example",
//       "newCorporateDisplayName": "Jane Doe",
//       "newCorporateMailAddress": "jdoe@target-tenant.example",
//       "sourceTenantLabel": "source-tenant",
//       "targetTenantLabel": "target-tenant"
//     }
// This input is a working input, not a permanent record -- once applied, the mapping lives in the
// ledger table, not the file/env var. Keep the file out of version control (e.g. under secrets/,
// gitignored) if you use the file-based form.

import { readFileSync } from 'fs';

import job from '../../job.js';
import { IProviders } from '../../interfaces/index.js';
import { setTarget } from './ledger.js';

const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ITargetEntry {
  thirdPartyUsername: string;
  newCorporateId: string;
  newCorporateUsername: string;
  newCorporateDisplayName?: string;
  newCorporateMailAddress?: string;
  sourceTenantLabel?: string;
  targetTenantLabel?: string;
}

job.run(setTargets, { name: 'Tenant migration: set targets' });

async function setTargets(providers: IProviders): Promise<void> {
  const batchId = requireEnv('TENANT_MIGRATION_BATCH_ID');
  const entries: ITargetEntry[] = JSON.parse(readTargetsJson());
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Targets input must contain a non-empty JSON array');
  }

  const pool = providers.postgresPool;
  let updated = 0;
  let notFound = 0;
  let invalid = 0;
  let skippedBlank = 0;

  for (const [index, entry] of entries.entries()) {
    const label = `[row ${index + 1}] ${entry?.thirdPartyUsername || '(missing thirdPartyUsername)'}`;
    if (isBlankEntry(entry)) {
      skippedBlank++;
      continue;
    }
    const problems = validateEntry(entry);
    if (problems.length > 0) {
      console.error(`${label}: SKIPPED invalid row - ${problems.join('; ')}`);
      invalid++;
      continue;
    }

    const rowCount = await setTarget(pool, batchId, entry.thirdPartyUsername, {
      newCorporateId: entry.newCorporateId,
      newCorporateUsername: entry.newCorporateUsername,
      newCorporateDisplayName: entry.newCorporateDisplayName,
      newCorporateMailAddress: entry.newCorporateMailAddress,
      sourceTenantLabel: entry.sourceTenantLabel,
      targetTenantLabel: entry.targetTenantLabel,
    });

    if (rowCount === 0) {
      console.error(
        `${label}: no matching "pending"/"needs-review" ledger row in batch ${batchId} (already set, wrong batch, or typo?)`
      );
      notFound++;
      continue;
    }

    console.log(`${label}: marked ready -> ${entry.newCorporateUsername}`);
    updated++;
  }

  console.log('');
  console.log('Summary:');
  console.log(`  ready:         ${updated}`);
  console.log(`  not found:     ${notFound}`);
  console.log(`  invalid:       ${invalid}`);
  console.log(`  skipped blank: ${skippedBlank} (no new* fields filled in -- not migrating these)`);
  if (updated > 0) {
    console.log('');
    console.log(
      `Next: run applyMigration.ts with TENANT_MIGRATION_BATCH_ID=${batchId} (dry run by default).`
    );
  }
}

function readTargetsJson(): string {
  const base64 = process.env.TENANT_MIGRATION_TARGETS_JSON_BASE64;
  if (base64) {
    return Buffer.from(base64, 'base64').toString('utf8');
  }
  const targetsFile = process.env.TENANT_MIGRATION_TARGETS_FILE;
  if (targetsFile) {
    return readFileSync(targetsFile, 'utf8');
  }
  throw new Error(
    'Set either TENANT_MIGRATION_TARGETS_FILE (path to a JSON file) or TENANT_MIGRATION_TARGETS_JSON_BASE64 (base64-encoded JSON)'
  );
}

function isBlankEntry(entry: ITargetEntry): boolean {
  return !entry?.newCorporateId && !entry?.newCorporateUsername;
}

function validateEntry(entry: ITargetEntry): string[] {
  const problems: string[] = [];
  if (!entry || typeof entry !== 'object') {
    return ['row is not an object'];
  }
  if (!entry.thirdPartyUsername) {
    problems.push('missing thirdPartyUsername');
  }
  if (!entry.newCorporateId) {
    problems.push('missing newCorporateId');
  } else if (!guidPattern.test(entry.newCorporateId)) {
    problems.push(`newCorporateId does not look like a GUID: ${entry.newCorporateId}`);
  }
  if (!entry.newCorporateUsername) {
    problems.push('missing newCorporateUsername');
  } else {
    // Require a nonempty, whitespace-free local part and domain -- `entry.includes('@')` alone
    // accepted obviously-invalid values like "@" or "user@" that would then be committed as the
    // account's corporate username.
    const [local, domain, ...rest] = entry.newCorporateUsername.split('@');
    if (rest.length > 0 || !local || !domain || /\s/.test(entry.newCorporateUsername)) {
      problems.push(`newCorporateUsername does not look like a valid UPN: ${entry.newCorporateUsername}`);
    }
  }
  return problems;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}
