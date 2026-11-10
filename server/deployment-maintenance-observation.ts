import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { AccountBindingSchema, SessionRuntimeBindingSchema } from '@mitzo/protocol';
import { maintenanceFingerprint } from '@mitzo/protocol/event-store';
import {
  CodexNativeTurnTargetSchema,
  type CodexConversationStore,
  type CodexNativeTurnTarget,
} from './codex-conversation-store.js';
import type { EventStore } from './event-store.js';
import { isAvailableTelosWorkConversation } from './telos-work-conversation.js';
import { assertOrdinaryContributorControlAllowed } from './ordinary-contributor-execution.js';

export interface MaintenanceOwner {
  sessionId: string;
  authoritySha256: string;
  custodySha256: string;
  /** Only turns running at capture need a positive matching completion. */
  target?: CodexNativeTurnTarget;
}

function authority(db: Database.Database, id: string) {
  const row = db
    .prepare(
      `SELECT cwd,account_binding,runtime_binding,repository_workspace_id,
    ordinary_workspace_id,selected_model,reasoning_effort,agent_profile,agent_context,
    symposium_config FROM sessions WHERE session_id=?`,
    )
    .get(id) as
    | {
        cwd: string;
        account_binding: string;
        runtime_binding: string;
        symposium_config: string | null;
      }
    | undefined;
  if (!row?.cwd || row.symposium_config) throw Error('Existing ordinary owner required');
  const account = AccountBindingSchema.parse(JSON.parse(row.account_binding));
  const binding = SessionRuntimeBindingSchema.parse(JSON.parse(row.runtime_binding));
  if (
    binding.version !== 2 ||
    binding.harness.implementation !== 'codex' ||
    binding.execution.location !== 'local' ||
    !isDeepStrictEqual(binding.account, {
      accountId: account.accountId,
      provider: account.provider,
      profileRevision: account.profileRevision,
    })
  )
    throw Error('Maintenance supports original local Codex owners only');
  return { row, account, binding };
}

/** Read-only capture while the installed source's real global hold is present.
 * No event/native store schema migration, inference, replay or interruption. */
export function captureMaintenanceOwner(
  db: Database.Database,
  native: CodexConversationStore,
  id: string,
  running: boolean,
): MaintenanceOwner {
  const { row, account } = authority(db, id);
  const conversation = native.read(id, account);
  const custody = native.readHostCustody(id, account);
  if (!custody || conversation.cwd !== row.cwd) throw Error('Original host custody unavailable');
  let target: CodexNativeTurnTarget | undefined;
  if (running) {
    // Each original running command must identify exactly one accepted turn.
    target = native.maintenanceRunningNativeTurnTarget(id, account);
    if (!target) throw Error('Exact accepted running turn required');
  }
  return {
    sessionId: id,
    authoritySha256: maintenanceFingerprint(row),
    custodySha256: maintenanceFingerprint(custody),
    ...(target ? { target: CodexNativeTurnTargetSchema.parse(target) } : {}),
  };
}

export function assertMaintenanceOwnerDrained(
  db: Database.Database,
  native: CodexConversationStore,
  owner: MaintenanceOwner,
) {
  const { row, account } = authority(db, owner.sessionId);
  if (
    maintenanceFingerprint(row) !== owner.authoritySha256 ||
    maintenanceFingerprint(native.readHostCustody(owner.sessionId, account)) !==
      owner.custodySha256 ||
    native.read(owner.sessionId, account).cwd !== row.cwd
  )
    throw Error('Original maintenance owner authority changed');
  if (
    native.hasRunningCommands(owner.sessionId) ||
    native.continuationBlocker(owner.sessionId, account)
  )
    throw Error('Original owner still has work or unknown effects');
  if (
    owner.target &&
    (!isDeepStrictEqual(
      native.maintenanceCompletedNativeTurnTarget(owner.sessionId, account),
      owner.target,
    ) ||
      !native.deploymentTurnSettled(owner.sessionId, account, owner.target))
  )
    throw Error('Original running turn did not complete naturally');
  return {
    sessionId: owner.sessionId,
    authoritySha256: owner.authoritySha256,
    custodySha256: owner.custodySha256,
    completionSha256: owner.target
      ? maintenanceFingerprint(
          native.readNativeExecution(owner.sessionId, account, {
            id: owner.target.commandId,
            attempt: owner.target.attempt,
          }),
        )
      : null,
  };
}

/** Final accepted-source validation reuses actual admission/identity semantics,
 * including prepared workspace settings; it never reconstructs those settings. */
export function assertMaintenanceAdmission(events: EventStore, owner: MaintenanceOwner): void {
  events.removals.assertAdmissible(owner.sessionId);
  assertOrdinaryContributorControlAllowed(events, owner.sessionId, 'interrupt');
  if (
    !isAvailableTelosWorkConversation(events.getSession(owner.sessionId)) ||
    events.getLatestEvent(owner.sessionId, 'adviser_task_scope')
  )
    throw Error('Original ordinary conversation is unavailable');
  const admission = events.getLatestOrdinaryCommandAdmission(owner.sessionId);
  if (
    !admission ||
    admission.state !== 'consumed' ||
    !isDeepStrictEqual(events.getSessionRuntimeBinding(owner.sessionId), admission.binding)
  )
    throw Error('Current consumed ordinary admission required');
}

/** Only originally running, positively drained owners receive the existing
 * deployment continuation. Idle owners retain history without new input. */
export function drainedMaintenanceSession(
  events: EventStore,
  native: CodexConversationStore,
  owner: MaintenanceOwner,
) {
  if (!owner.target) throw Error('Captured running target required');
  assertMaintenanceAdmission(events, owner);
  const completed = assertMaintenanceOwnerDrainedForEntry(
    native,
    owner,
    events.getSession(owner.sessionId)!.accountBinding!,
  );
  const meta = events.getSession(owner.sessionId)!;
  const admission = events.getLatestOrdinaryCommandAdmission(owner.sessionId)!;
  return {
    sessionId: owner.sessionId,
    custodySha256: owner.custodySha256,
    completionSha256: completed,
    snapshot: {
      target: owner.target,
      account: meta.accountBinding!,
      binding: admission.binding,
      cwd: meta.cwd!,
      settings: {
        binding: admission.binding,
        selection: admission.selection,
        repositoryWorkspaceId: admission.workspace.workspaceId,
      },
    },
  };
}
function assertMaintenanceOwnerDrainedForEntry(
  native: CodexConversationStore,
  owner: MaintenanceOwner,
  account: NonNullable<ReturnType<EventStore['getSession']>>['accountBinding'],
) {
  if (
    !owner.target ||
    !account ||
    native.commandStatus(owner.sessionId, account, owner.target.commandId) !== 'completed' ||
    !native.deploymentTurnSettled(owner.sessionId, account, owner.target) ||
    maintenanceFingerprint(native.readHostCustody(owner.sessionId, account)) !== owner.custodySha256
  )
    throw Error('Original completed owner proof changed');
  return maintenanceFingerprint(
    native.readNativeExecution(owner.sessionId, account, {
      id: owner.target.commandId,
      attempt: owner.target.attempt,
    }),
  );
}
export function drainedMaintenanceEntrySettled(
  events: EventStore,
  native: CodexConversationStore,
  entry: ReturnType<EventStore['deployment']['get']>['sessions'][number],
): boolean {
  const proof = entry.drainedProof;
  const operation = events.deployment.active();
  if (
    !proof ||
    proof.kind !== 'naturally-completed-v1' ||
    operation?.maintenance?.kind !== 'drained-handoff-v1' ||
    proof.handoffSha256 !== operation.maintenance.proofSha256 ||
    !operation.sessions.some(
      (saved) =>
        saved.sessionId === entry.sessionId &&
        saved.resumeId === entry.resumeId &&
        isDeepStrictEqual(saved.drainedProof, proof),
    )
  )
    return false;
  const meta = events.getSession(entry.sessionId);
  const target = CodexNativeTurnTargetSchema.parse(entry.snapshot.target);
  if (!meta?.accountBinding || maintenanceFingerprint(target) !== proof.targetSha256) return false;
  const owner = {
    sessionId: entry.sessionId,
    target,
    custodySha256: proof.custodySha256,
    authoritySha256: '',
  };
  return (
    assertMaintenanceOwnerDrainedForEntry(native, owner, meta.accountBinding) ===
    proof.completionSha256
  );
}
