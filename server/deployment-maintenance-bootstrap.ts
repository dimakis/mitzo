import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { maintenanceFingerprint } from '@mitzo/protocol/event-store';
import {
  MaintenancePlan,
  MaintenanceSeal,
  MaintenanceRequirement,
} from './deployment-maintenance-format.js';
import {
  readPrivateOperationFile,
  publishPrivateOperationFile,
  assertPrivateOperationDirectory,
  upgradePrivateOperationFile,
} from './private-operation-file.js';
import { codexPrivateDirectory } from './codex-private-path.js';
import { CodexConversationStore } from './codex-conversation-store.js';
import { assertMaintenanceOwnerDrained } from './deployment-maintenance-observation.js';
import { maintenanceIdleFingerprint } from './deployment-maintenance-idle.js';
import { getLocalCommit } from './git-version.js';
import type { z } from 'zod';
import type { EventStore } from './event-store.js';
import {
  inspectMaintenanceDatabases,
  publishMaintenanceIdentity,
  readMaintenanceIdentity,
  readMaintenanceVolumeUuids,
} from './deployment-maintenance-identity.js';

/** Historical acceptance evidence, never a renewal of the captured actor or a
 * grant to resume. The normal deployment API must still authorize delivery. */
export function assertMaintenanceBootstrap(
  db: Database.Database,
  plan: z.infer<typeof MaintenancePlan>,
  seal: z.infer<typeof MaintenanceSeal>,
  commit: string | null,
): NonNullable<ReturnType<EventStore['deployment']['get']>> {
  const deny = () => {
    throw Error('Reviewed maintenance adoption is required before application startup');
  };
  if (!commit || !/^[a-f0-9]{40}$/.test(commit) || seal.planSha256 !== maintenanceFingerprint(plan))
    deny();
  const row = db.prepare('SELECT data,held FROM deployment_operations WHERE id=?').get(plan.id) as
    { data: string; held: number } | undefined;
  const original = db
    .prepare('SELECT data,held FROM deployment_operations WHERE id=?')
    .get(plan.sourceOperationId) as { data: string; held: number } | undefined;
  if (
    !row ||
    !original ||
    original.held !== 0 ||
    maintenanceFingerprint(original.data) !== plan.sourceOperationSha256
  )
    deny();
  const operation = JSON.parse(row!.data) as ReturnType<EventStore['deployment']['get']>;
  const proof = operation.maintenance;
  if (
    operation.id !== plan.id ||
    operation.sourceCommit !== plan.sourceCommit ||
    operation.targetCommit !== plan.targetCommit ||
    operation.activationHash ||
    proof?.kind !== 'drained-handoff-v1' ||
    proof.authorityHash !== createHash('sha256').update(plan.authorityId).digest('hex') ||
    new Set(plan.owners.map((owner) => owner.sessionId)).size !== plan.owners.length ||
    new Set(plan.expectedCommands.map((command) => command.commandId)).size !==
      plan.expectedCommands.length ||
    proof.sourceOperationId !== plan.sourceOperationId ||
    proof.sourceOperationSha256 !== plan.sourceOperationSha256 ||
    proof.idleSnapshotSha256 !== plan.idleSnapshotSha256 ||
    !['activating', 'resuming', 'completed'].includes(operation.phase) ||
    (operation.phase !== 'completed' && commit !== plan.targetCommit) ||
    row!.held !== (operation.phase === 'completed' ? 0 : 1)
  )
    deny();
  const running = plan.owners.filter((owner) => owner.target);
  if (plan.idleSnapshotSha256 && (running.length || operation.sessions.length)) deny();
  if (
    operation.sessions.length !== running.length ||
    new Set(operation.sessions.map((entry) => entry.sessionId)).size !== running.length
  )
    deny();
  const completions = plan.owners.map((owner) => {
    const entry = operation.sessions.find((entry) => entry.sessionId === owner.sessionId);
    if (!owner.target) {
      if (entry) deny();
      return { ...owner, completionSha256: null };
    }
    if (
      !entry ||
      entry.pauseSettled ||
      entry.drainedProof?.kind !== 'naturally-completed-v1' ||
      entry.drainedProof.targetSha256 !== maintenanceFingerprint(owner.target) ||
      maintenanceFingerprint(entry.snapshot.target) !== maintenanceFingerprint(owner.target) ||
      entry.drainedProof.custodySha256 !== owner.custodySha256 ||
      entry.drainedProof.handoffSha256 !== proof!.proofSha256
    )
      deny();
    return {
      sessionId: owner.sessionId,
      authoritySha256: owner.authoritySha256,
      custodySha256: owner.custodySha256,
      completionSha256: entry!.drainedProof!.completionSha256,
    };
  });
  if (
    maintenanceFingerprint(completions) !== seal.completionSha256 ||
    proof!.proofSha256 !==
      maintenanceFingerprint({
        planSha256: maintenanceFingerprint(plan),
        completionSha256: seal.completionSha256,
        helpers: seal.helpers,
      })
  )
    deny();
  const expected = new Map(
    plan.expectedCommands.map((command) => [command.commandId, command.sha256]),
  );
  const quarantined = db
    .prepare(
      'SELECT session_id,operation_id,length(original_commands) AS bytes FROM deployment_quarantines WHERE operation_id=? ORDER BY session_id',
    )
    .all(plan.id) as Array<{ session_id: string; operation_id: string; bytes: number }>;
  const historicalIds: string[] = [];
  for (const item of quarantined) {
    if (
      item.bytes > 64 * 1024 * 1024 ||
      plan.owners.some((owner) => owner.sessionId === item.session_id)
    )
      deny();
    const saved = db
      .prepare('SELECT original_commands FROM deployment_quarantines WHERE session_id=?')
      .get(item.session_id) as { original_commands: string };
    const commands = JSON.parse(saved.original_commands) as Array<{
      client_msg_id: string;
      session_id: string;
    }>;
    if (!Array.isArray(commands) || !commands.length) deny();
    for (const command of commands) {
      const hash = expected.get(command.client_msg_id);
      if (
        command.session_id !== item.session_id ||
        !hash ||
        maintenanceFingerprint(command) !== hash ||
        maintenanceFingerprint(
          db
            .prepare('SELECT * FROM send_commands WHERE client_msg_id=?')
            .get(command.client_msg_id),
        ) !== hash
      )
        deny();
      expected.delete(command.client_msg_id);
    }
    historicalIds.push(item.session_id);
  }
  if (
    expected.size ||
    maintenanceFingerprint(historicalIds) !==
      maintenanceFingerprint([...proof!.quarantinedSessionIds].sort()) ||
    maintenanceFingerprint(proof!.retainedSessionIds) !==
      maintenanceFingerprint(plan.owners.map((owner) => owner.sessionId))
  )
    deny();
  return operation!;
}

/** Permanent private requirement survives a restored events file and an omitted
 * environment selector. Publication precedes adoption; it never grants resume. */
export function persistMaintenanceRequirement(
  path: string,
  plan: z.infer<typeof MaintenancePlan>,
  seal: z.infer<typeof MaintenanceSeal>,
  captureStableIdentity = false,
): void {
  const root = resolve(join(codexPrivateDirectory(), 'deployment'));
  if (dirname(resolve(path)) !== root || realpathSync(root) !== root)
    throw Error('Protected physical operation directory required');
  assertPrivateOperationDirectory(root);
  const value = {
    version: 1 as const,
    planFile: resolve(path),
    planSha256: maintenanceFingerprint(plan),
    sealSha256: maintenanceFingerprint(seal),
  };
  const marker = join(root, 'required-handoff.json');
  const initial = Buffer.from(JSON.stringify(value) + '\n');
  let bytes: Buffer;
  try {
    bytes = readPrivateOperationFile(marker, requirementByteLimit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    publishPrivateOperationFile(marker, initial.toString('utf8'));
    bytes = initial;
  }
  const existing = MaintenanceRequirement.parse(JSON.parse(bytes.toString('utf8')));
  if (
    existing.planFile !== value.planFile ||
    existing.planSha256 !== value.planSha256 ||
    existing.sealSha256 !== value.sealSha256
  )
    throw Error('Retained maintenance requirement changed');
  if (captureStableIdentity) {
    const identities = inspectMaintenanceDatabases(
      plan,
      configuredDatabases(),
      true,
      readMaintenanceVolumeUuids,
    )!;
    const identity = publishMaintenanceIdentity(existing, 'original-device', identities);
    requirePersistentIdentity(marker, bytes, existing, identity);
  }
}

const requirementByteLimit = 16 * 1024;

function requirePersistentIdentity(
  marker: string,
  previous: Buffer,
  requirement: z.infer<typeof MaintenanceRequirement>,
  identity: ReturnType<typeof publishMaintenanceIdentity>,
) {
  if (requirement.version === 2) return;
  const next = {
    ...requirement,
    version: 2,
    databaseIdentitySha256: maintenanceFingerprint(identity),
  };
  upgradePrivateOperationFile(marker, previous, JSON.stringify(next) + '\n', requirementByteLimit);
}

function configuredDatabases(): [string, string] {
  return [
    join(process.env.REPO_PATH || '.', '.mitzo/events.db'),
    join(codexPrivateDirectory(), 'conversations.db'),
  ];
}

function readRequiredHandoff() {
  const selected = process.env.MITZO_MAINTENANCE_PLAN_FILE;
  if (Object.hasOwn(process.env, 'MITZO_MAINTENANCE_PLAN_FILE') && !selected)
    throw Error('Explicit maintenance selector must name its protected plan');
  const root = resolve(join(codexPrivateDirectory(), 'deployment'));
  const marker = join(root, 'required-handoff.json');
  let bytes: Buffer;
  try {
    bytes = readPrivateOperationFile(marker, requirementByteLimit);
  } catch (error) {
    if (!selected && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const required = MaintenanceRequirement.parse(JSON.parse(bytes.toString('utf8')));
  const path = required.planFile;
  if (
    (selected && resolve(selected) !== path) ||
    dirname(resolve(path)) !== root ||
    realpathSync(root) !== root
  )
    throw Error('Protected physical maintenance directory required');
  assertPrivateOperationDirectory(root);
  const plan = MaintenancePlan.parse(
    JSON.parse(readPrivateOperationFile(path, 1024 * 1024).toString('utf8')),
  );
  const seal = MaintenanceSeal.parse(
    JSON.parse(readPrivateOperationFile(path + '.sealed.json', 1024 * 1024).toString('utf8')),
  );
  if (
    required.planSha256 !== maintenanceFingerprint(plan) ||
    required.sealSha256 !== maintenanceFingerprint(seal)
  )
    throw Error('Original private maintenance requirement changed');
  return { required, plan, seal, marker, bytes };
}

/** Explicit local operator action after verifying provenance of both legacy files. */
export function migrateCompletedMaintenanceIdentity(
  planSha256: string,
  attestedVolumes: [string, string],
  volumeProbe = readMaintenanceVolumeUuids,
): void {
  const evidence = readRequiredHandoff();
  if (!evidence || evidence.required.planSha256 !== planSha256)
    throw Error('Exact reviewed maintenance plan fingerprint required');
  const { required, plan, seal, marker, bytes } = evidence;
  const configured = configuredDatabases();
  const identities = inspectMaintenanceDatabases(plan, configured, false, volumeProbe)!;
  if (
    identities.events.volumeUuid !== attestedVolumes[0].toLowerCase() ||
    identities.native.volumeUuid !== attestedVolumes[1].toLowerCase()
  )
    throw Error('Database volume does not match the operator’s reviewed volume');
  const sealedAt = lstatSync(required.planFile + '.sealed.json', { bigint: true }).birthtimeNs;
  if (
    sealedAt <= 0n ||
    [identities.events, identities.native].some((identity) => BigInt(identity.birthNs) > sealedAt)
  )
    throw Error('Original databases must predate the retained handoff seal');

  const db = new Database(plan.events.path, { readonly: true, fileMustExist: true });
  try {
    if (assertMaintenanceBootstrap(db, plan, seal, getLocalCommit()).phase !== 'completed')
      throw Error('Database identity migration requires a completed handoff');
    if (
      !isDeepStrictEqual(
        identities,
        inspectMaintenanceDatabases(plan, configured, false, volumeProbe),
      )
    )
      throw Error('Maintenance databases changed during migration');
    const identity = publishMaintenanceIdentity(required, 'completed-handoff', identities);
    requirePersistentIdentity(marker, bytes, required, identity);
  } finally {
    db.close();
  }
}

/** Runs through index's first dependency before application or recovery imports. */
export function validateMaintenanceBootstrap(
  volumeProbe = readMaintenanceVolumeUuids,
): z.infer<typeof MaintenancePlan> | undefined {
  const evidence = readRequiredHandoff();
  if (!evidence) return;
  const { required, plan, seal } = evidence;
  const identity = readMaintenanceIdentity(required);
  // Match the database paths before application imports can open another store.
  const current = inspectMaintenanceDatabases(
    plan,
    configuredDatabases(),
    !identity,
    identity ? volumeProbe : undefined,
  );
  if (identity && !isDeepStrictEqual(current, { events: identity.events, native: identity.native }))
    throw Error('Configured runtime database must retain its persistent maintenance identity');
  const db = new Database(plan.events.path, { readonly: true, fileMustExist: true });
  try {
    const operation = assertMaintenanceBootstrap(db, plan, seal, getLocalCommit());
    if (identity?.basis === 'completed-handoff' && operation.phase !== 'completed')
      throw Error('Migrated database identity requires the original completed handoff');
    if (plan.idleSnapshotSha256 && operation.phase !== 'completed') {
      const native = new CodexConversationStore(plan.native.path, { observation: true });
      try {
        for (const owner of plan.owners) assertMaintenanceOwnerDrained(db, native, owner);
        if (
          maintenanceIdleFingerprint(
            db,
            native,
            plan.events.path,
            operation.maintenance!.quarantinedSessionIds,
            plan.owners.map((owner) => owner.sessionId),
          ) !== plan.idleSnapshotSha256
        )
          throw Error('Original idle snapshot changed before zero-delivery handoff');
      } finally {
        native.close();
      }
    }
  } finally {
    db.close();
  }
  return plan;
}
