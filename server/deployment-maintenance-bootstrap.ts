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
} from './private-operation-file.js';
import { codexPrivateDirectory } from './codex-private-path.js';
import { getLocalCommit } from './git-version.js';
import type { z } from 'zod';
import type { EventStore } from './event-store.js';

/** Historical acceptance evidence, never a renewal of the captured actor or a
 * grant to resume. The normal deployment API must still authorize delivery. */
export function assertMaintenanceBootstrap(
  db: Database.Database,
  plan: z.infer<typeof MaintenancePlan>,
  seal: z.infer<typeof MaintenanceSeal>,
  commit: string | null,
): void {
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
    !['activating', 'resuming', 'completed'].includes(operation.phase) ||
    (operation.phase !== 'completed' && commit !== plan.targetCommit) ||
    row!.held !== (operation.phase === 'completed' ? 0 : 1)
  )
    deny();
  const running = plan.owners.filter((owner) => owner.target);
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
}

/** Permanent private requirement survives a restored events file and an omitted
 * environment selector. Publication precedes adoption; it never grants resume. */
export function persistMaintenanceRequirement(
  path: string,
  plan: z.infer<typeof MaintenancePlan>,
  seal: z.infer<typeof MaintenanceSeal>,
): void {
  const root = resolve(join(codexPrivateDirectory(), 'deployment'));
  if (dirname(resolve(path)) !== root || realpathSync(root) !== root)
    throw Error('Protected physical operation directory required');
  assertPrivateOperationDirectory(root);
  const value = {
    version: 1,
    planFile: resolve(path),
    planSha256: maintenanceFingerprint(plan),
    sealSha256: maintenanceFingerprint(seal),
  };
  const marker = join(root, 'required-handoff.json');
  try {
    const existing = MaintenanceRequirement.parse(
      JSON.parse(readPrivateOperationFile(marker, 16 * 1024).toString('utf8')),
    );
    if (!isDeepStrictEqual(existing, value))
      throw Error('Retained maintenance requirement changed');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    publishPrivateOperationFile(marker, JSON.stringify(value) + '\n');
  }
}

/** Runs through index's first dependency before application or recovery imports. */
export function validateMaintenanceBootstrap(): void {
  const selected = process.env.MITZO_MAINTENANCE_PLAN_FILE;
  if (Object.hasOwn(process.env, 'MITZO_MAINTENANCE_PLAN_FILE') && !selected)
    throw Error('Explicit maintenance selector must name its protected plan');
  const root = resolve(join(codexPrivateDirectory(), 'deployment'));
  let required: z.infer<typeof MaintenanceRequirement>;
  try {
    required = MaintenanceRequirement.parse(
      JSON.parse(
        readPrivateOperationFile(join(root, 'required-handoff.json'), 16 * 1024).toString('utf8'),
      ),
    );
  } catch (error) {
    if (!selected && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
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
  // Match the paths the application will actually open, before its imports can
  // create another store or recover owners outside the adopted hold.
  for (const [configured, original] of [
    [join(process.env.REPO_PATH || '.', '.mitzo/events.db'), plan.events],
    [join(codexPrivateDirectory(), 'conversations.db'), plan.native],
  ] as const) {
    const identity = lstatSync(configured);
    const retained = lstatSync(original.path);
    if (
      !identity.isFile() ||
      !retained.isFile() ||
      identity.uid !== process.getuid?.() ||
      retained.uid !== process.getuid?.() ||
      identity.nlink !== 1 ||
      retained.nlink !== 1 ||
      realpathSync(configured) !== realpathSync(original.path) ||
      identity.dev !== original.identity.dev ||
      identity.ino !== original.identity.ino ||
      retained.dev !== original.identity.dev ||
      retained.ino !== original.identity.ino
    )
      throw Error('Configured runtime database must retain original maintenance identity');
  }
  const db = new Database(plan.events.path, { readonly: true, fileMustExist: true });
  try {
    assertMaintenanceBootstrap(db, plan, seal, getLocalCommit());
  } finally {
    db.close();
  }
}
