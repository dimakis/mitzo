import Database from 'better-sqlite3';
import { lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { readCustodianRetirementReceipt } from './symposium-custodian-retirement.js';

export interface LostCustodyReportInput {
  eventDb: string;
  stateParent: string;
}

/** Read-only triage after parent, gateway, or host loss. This observes durable
 * identities but cannot reconstruct a live issuer, physical stop receipt, or
 * authenticated operator authority. It never returns an adopt/cleanup grant. */
export function reportLostSymposiumCustody(input: LostCustodyReportInput) {
  const ownedPath = (path: string, directory: boolean, privateMode: boolean) => {
    if (!isAbsolute(path)) throw new Error('Recovery assessment requires absolute paths');
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink() ||
      (directory ? !stat.isDirectory() : !stat.isFile()) ||
      stat.uid !== process.getuid?.() ||
      (privateMode && Boolean(stat.mode & 0o077))
    )
      throw new Error('Recovery assessment requires private owned ledgers');
  };
  ownedPath(input.stateParent, true, true);
  const artifactDb = join(input.stateParent, 'session-artifacts.db');
  const leaseDb = join(input.stateParent, 'artifact-leases.db');
  // The ordinary EventStore is created under .mitzo with the process umask;
  // owned-host ledgers and their parent have the stronger private-mode contract.
  ownedPath(input.eventDb, false, false);
  for (const path of [artifactDb, leaseDb]) ownedPath(path, false, true);
  const event = new Database(input.eventDb, { readonly: true, fileMustExist: true });
  const artifact = new Database(artifactDb, { readonly: true, fileMustExist: true });
  const lease = new Database(leaseDb, { readonly: true, fileMustExist: true });
  try {
    const memberships = event
      .prepare(
        `SELECT m.session_id AS sessionId, m.seat_id AS seatId,
                m.generation, m.state, r.status AS reconciliation
           FROM symposium_membership m
           JOIN (SELECT session_id,seat_id,MAX(generation) AS generation
                   FROM symposium_membership GROUP BY session_id,seat_id) latest
             ON latest.session_id=m.session_id AND latest.seat_id=m.seat_id
            AND latest.generation=m.generation
           LEFT JOIN symposium_membership_reconciliation r
             ON r.session_id=m.session_id AND r.seat_id=m.seat_id
            AND r.generation=m.generation
          ORDER BY m.session_id,m.seat_id`,
      )
      .all() as {
      sessionId: string;
      seatId: string;
      generation: number;
      state: string;
      reconciliation: string | null;
    }[];
    const sandboxes = event
      .prepare(
        `SELECT session_id AS sessionId,seat_id AS seatId,generation,
                sandbox_name AS sandboxName,physical_id AS physicalId,state
           FROM symposium_seat_sandboxes
          WHERE state!='stopped'
          ORDER BY session_id,seat_id,generation`,
      )
      .all() as {
      sessionId: string;
      seatId: string;
      generation: number;
      sandboxName: string | null;
      physicalId: string | null;
      state: string;
    }[];
    const artifactRows = artifact
      .prepare(
        `SELECT session_id AS sessionId,custody,volume_name AS volumeName,state
           FROM symposium_session_artifacts ORDER BY session_id`,
      )
      .all() as { sessionId: string; custody: string; volumeName: string; state: string }[];
    const artifacts = artifactRows.map(({ sessionId, volumeName, state }) => ({
      sessionId,
      volumeName,
      state,
    }));
    const leases = lease
      .prepare(
        `SELECT volume_name AS volumeName,access,sandbox_name AS sandboxName,
                sandbox_id AS physicalId
           FROM symposium_artifact_leases ORDER BY volume_name,access,sandbox_name`,
      )
      .all() as {
      volumeName: string;
      access: string;
      sandboxName: string | null;
      physicalId: string | null;
    }[];
    const count = (db: Database.Database, table: string) =>
      (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    const pendingCreationRecoveries = (
      event
        .prepare(
          'SELECT COUNT(*) AS count FROM symposium_creation_recoveries WHERE result_json IS NULL',
        )
        .get() as { count: number }
    ).count;
    const lifecycleFences = count(event, 'symposium_seat_lifecycle_fences');
    const pendingArtifactRetention = count(lease, 'symposium_artifact_pending_retention');
    const unsettled =
      memberships.some((row) => row.state === 'active' || row.reconciliation !== 'confirmed') ||
      sandboxes.length > 0 ||
      artifacts.some((row) => row.state !== 'ready') ||
      leases.length > 0 ||
      pendingCreationRecoveries > 0 ||
      lifecycleFences > 0 ||
      pendingArtifactRetention > 0;
    let retirementReceipt: 'absent' | 'matching' | 'mismatch' | 'conflicting_state' | 'invalid' =
      'absent';
    try {
      const receipt = readCustodianRetirementReceipt(input.stateParent);
      if (receipt) {
        const otherGatewayLaunch = readdirSync(input.stateParent)
          .filter((name) => name.startsWith('gateway-'))
          .some((name) => join(input.stateParent, name) !== receipt.gatewayStateDirectory);
        retirementReceipt = artifactRows.every(
          (row) => row.custody === receipt.gatewayStateDirectory,
        )
          ? unsettled || otherGatewayLaunch
            ? 'conflicting_state'
            : 'matching'
          : 'mismatch';
      }
    } catch {
      retirementReceipt = 'invalid';
    }
    return {
      disposition: 'fenced_requires_authenticated_reconciliation' as const,
      physicalProof: 'unavailable' as const,
      lastOwnerShutdown:
        retirementReceipt === 'matching'
          ? ('confirmed_at_receipt' as const)
          : ('unconfirmed' as const),
      retirementReceipt,
      memberships,
      sandboxes,
      artifacts,
      leases,
      pendingCreationRecoveries,
      lifecycleFences,
      pendingArtifactRetention,
      nextAction:
        'Keep old resources retained. Establish fresh authenticated authority and exact physical inventory before any stop, export, or retirement mutation.',
    };
  } finally {
    lease.close();
    artifact.close();
    event.close();
  }
}
