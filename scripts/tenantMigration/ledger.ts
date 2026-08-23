//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

// Shared data access for the `identitytenantmigrations` ledger table. This table is the durable
// record of an in-progress corporate-identity tenant migration (source tenant -> target tenant,
// e.g. a tenant split/merge or an org moving to its own tenant): one row per third-party (GitHub)
// identity, tracking the corporate identity
// as discovered, the intended new corporate identity, and what was actually applied -- so state
// survives regardless of where the scripts are run from (no reliance on local files left behind
// on a Kudu console or a throwaway shell).

import { randomUUID } from 'crypto';

import type { Pool as PostgresPool } from 'pg';

import { PostgresPoolQueryAsync } from '../../lib/postgresHelpers.js';

export const TABLE_NAME = 'identitytenantmigrations';

export type TenantMigrationStatus =
  | 'pending' // discovered as a likely candidate (stale-domain match), no target identity yet
  | 'needs-review' // discovered, linked, but no strong signal either way -- inspect by hand
  | 'skipped-already-migrated' // discovered, but already matches the target domain
  | 'ready' // target identity has been set, ready to apply
  | 'applied' // successfully patched the `links` row
  | 'conflict' // live link state didn't match what was discovered -- not applied, needs re-review
  | 'failed'; // apply was attempted and errored

export interface ITenantMigrationLedgerRow {
  id: string;
  batchId: string;
  thirdPartyType: string;
  thirdPartyId: string;
  thirdPartyUsername: string;
  discoveredCorporateId: string;
  discoveredCorporateUsername: string;
  discoveredCorporateDisplayName: string;
  discoveredCorporateMailAddress: string;
  newCorporateId: string;
  newCorporateUsername: string;
  newCorporateDisplayName: string;
  newCorporateMailAddress: string;
  sourceTenantLabel: string;
  targetTenantLabel: string;
  status: TenantMigrationStatus;
  notes: string;
  lastError: string;
  createdAt: Date;
  updatedAt: Date;
  appliedAt: Date;
}

export interface ICandidateDiscovery {
  thirdPartyType?: string;
  thirdPartyId: string;
  thirdPartyUsername: string;
  discoveredCorporateId: string;
  discoveredCorporateUsername: string;
  discoveredCorporateDisplayName: string;
  discoveredCorporateMailAddress: string;
  status: TenantMigrationStatus;
  notes?: string;
}

export interface IMigrationTarget {
  newCorporateId: string;
  newCorporateUsername: string;
  newCorporateDisplayName?: string;
  newCorporateMailAddress?: string;
  sourceTenantLabel?: string;
  targetTenantLabel?: string;
}

export async function ensureSchema(pool: PostgresPool): Promise<void> {
  await PostgresPoolQueryAsync(
    pool,
    `
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      id text PRIMARY KEY,
      batchid text NOT NULL,
      thirdpartytype text NOT NULL DEFAULT 'github',
      thirdpartyid text NOT NULL,
      thirdpartyusername text,

      discoveredcorporateid text,
      discoveredcorporateusername text,
      discoveredcorporatedisplayname text,
      discoveredcorporatemailaddress text,

      newcorporateid text,
      newcorporateusername text,
      newcorporatedisplayname text,
      newcorporatemailaddress text,

      sourcetenantlabel text,
      targettenantlabel text,

      status text NOT NULL DEFAULT 'pending',
      notes text,
      lasterror text,

      beforesnapshot jsonb,
      aftersnapshot jsonb,

      createdat timestamptz NOT NULL DEFAULT now(),
      updatedat timestamptz NOT NULL DEFAULT now(),
      appliedat timestamptz
    )
  `,
    []
  );
  await PostgresPoolQueryAsync(
    pool,
    `CREATE UNIQUE INDEX IF NOT EXISTS identitytenantmigrations_batch_thirdparty
       ON ${TABLE_NAME} (batchid, thirdpartytype, thirdpartyid)`,
    []
  );
  await PostgresPoolQueryAsync(
    pool,
    `CREATE INDEX IF NOT EXISTS identitytenantmigrations_status ON ${TABLE_NAME} (status)`,
    []
  );
  await PostgresPoolQueryAsync(
    pool,
    `CREATE INDEX IF NOT EXISTS identitytenantmigrations_batch ON ${TABLE_NAME} (batchid)`,
    []
  );
}

// Idempotent: re-running discovery updates rows still in a "not yet actioned" status, but never
// clobbers a row that has already been set up to apply, applied, or flagged as a conflict.
export async function upsertCandidate(
  pool: PostgresPool,
  batchId: string,
  entry: ICandidateDiscovery
): Promise<void> {
  await PostgresPoolQueryAsync(
    pool,
    `
    INSERT INTO ${TABLE_NAME} (
      id, batchid, thirdpartytype, thirdpartyid, thirdpartyusername,
      discoveredcorporateid, discoveredcorporateusername, discoveredcorporatedisplayname, discoveredcorporatemailaddress,
      status, notes, createdat, updatedat
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now())
    ON CONFLICT (batchid, thirdpartytype, thirdpartyid) DO UPDATE SET
      thirdpartyusername = excluded.thirdpartyusername,
      discoveredcorporateid = excluded.discoveredcorporateid,
      discoveredcorporateusername = excluded.discoveredcorporateusername,
      discoveredcorporatedisplayname = excluded.discoveredcorporatedisplayname,
      discoveredcorporatemailaddress = excluded.discoveredcorporatemailaddress,
      status = excluded.status,
      notes = excluded.notes,
      updatedat = now()
    WHERE ${TABLE_NAME}.status IN ('pending', 'needs-review', 'skipped-already-migrated')
  `,
    [
      randomUUID(),
      batchId,
      entry.thirdPartyType || 'github',
      entry.thirdPartyId,
      entry.thirdPartyUsername,
      entry.discoveredCorporateId,
      entry.discoveredCorporateUsername,
      entry.discoveredCorporateDisplayName,
      entry.discoveredCorporateMailAddress,
      entry.status,
      entry.notes || null,
    ]
  );
}

export async function setTarget(
  pool: PostgresPool,
  batchId: string,
  thirdPartyUsername: string,
  target: IMigrationTarget
): Promise<number> {
  const result = await PostgresPoolQueryAsync(
    pool,
    `
    UPDATE ${TABLE_NAME}
    SET newcorporateid = $1,
        newcorporateusername = $2,
        newcorporatedisplayname = $3,
        newcorporatemailaddress = $4,
        sourcetenantlabel = $5,
        targettenantlabel = $6,
        status = 'ready',
        updatedat = now()
    WHERE batchid = $7
      AND lower(thirdpartyusername) = lower($8)
      AND status IN ('pending', 'needs-review', 'ready')
  `,
    [
      target.newCorporateId,
      target.newCorporateUsername,
      target.newCorporateDisplayName || null,
      target.newCorporateMailAddress || target.newCorporateUsername,
      target.sourceTenantLabel || null,
      target.targetTenantLabel || null,
      batchId,
      thirdPartyUsername,
    ]
  );
  return result.rowCount as number;
}

// Resets any "ready" rows in the batch NOT present in keepThirdPartyUsernames back to
// "needs-review". Called after a setTargets.ts run so a stale target from an earlier
// submission (since removed, blanked, or replaced by an invalid row) can't still be picked
// up by a later applyMigration.ts run.
export async function revokeReadyExcept(
  pool: PostgresPool,
  batchId: string,
  keepThirdPartyUsernames: string[]
): Promise<number> {
  const result = await PostgresPoolQueryAsync(
    pool,
    `
    UPDATE ${TABLE_NAME}
    SET status = 'needs-review',
        updatedat = now()
    WHERE batchid = $1
      AND status = 'ready'
      AND NOT (lower(thirdpartyusername) = ANY($2))
  `,
    [batchId, keepThirdPartyUsernames.map((username) => username.toLowerCase())]
  );
  return result.rowCount as number;
}

export async function listByStatus(
  pool: PostgresPool,
  batchId: string,
  statuses: TenantMigrationStatus[]
): Promise<ITenantMigrationLedgerRow[]> {
  const result = await PostgresPoolQueryAsync(
    pool,
    `
    SELECT *
    FROM ${TABLE_NAME}
    WHERE batchid = $1
      AND status = ANY($2)
    ORDER BY createdat ASC
  `,
    [batchId, statuses]
  );
  return result.rows.map(rowToLedgerEntry);
}

export async function markApplied(
  pool: PostgresPool,
  id: string,
  beforeSnapshot: unknown,
  afterSnapshot: unknown
): Promise<void> {
  await PostgresPoolQueryAsync(
    pool,
    `
    UPDATE ${TABLE_NAME}
    SET status = 'applied',
        beforesnapshot = $2,
        aftersnapshot = $3,
        appliedat = now(),
        updatedat = now(),
        lasterror = NULL
    WHERE id = $1
  `,
    [id, JSON.stringify(beforeSnapshot), JSON.stringify(afterSnapshot)]
  );
}

export async function markConflict(pool: PostgresPool, id: string, notes: string): Promise<void> {
  await PostgresPoolQueryAsync(
    pool,
    `
    UPDATE ${TABLE_NAME}
    SET status = 'conflict',
        notes = $2,
        updatedat = now()
    WHERE id = $1
  `,
    [id, notes]
  );
}

export async function markFailed(pool: PostgresPool, id: string, errorMessage: string): Promise<void> {
  await PostgresPoolQueryAsync(
    pool,
    `
    UPDATE ${TABLE_NAME}
    SET status = 'failed',
        lasterror = $2,
        updatedat = now()
    WHERE id = $1
  `,
    [id, errorMessage]
  );
}

function rowToLedgerEntry(row: any): ITenantMigrationLedgerRow {
  return {
    id: row.id,
    batchId: row.batchid,
    thirdPartyType: row.thirdpartytype,
    thirdPartyId: row.thirdpartyid,
    thirdPartyUsername: row.thirdpartyusername,
    discoveredCorporateId: row.discoveredcorporateid,
    discoveredCorporateUsername: row.discoveredcorporateusername,
    discoveredCorporateDisplayName: row.discoveredcorporatedisplayname,
    discoveredCorporateMailAddress: row.discoveredcorporatemailaddress,
    newCorporateId: row.newcorporateid,
    newCorporateUsername: row.newcorporateusername,
    newCorporateDisplayName: row.newcorporatedisplayname,
    newCorporateMailAddress: row.newcorporatemailaddress,
    sourceTenantLabel: row.sourcetenantlabel,
    targetTenantLabel: row.targettenantlabel,
    status: row.status,
    notes: row.notes,
    lastError: row.lasterror,
    createdAt: row.createdat,
    updatedAt: row.updatedat,
    appliedAt: row.appliedat,
  };
}
