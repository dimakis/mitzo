import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { EventStore } from './event-store.js';
import type { PendingHostTaskRequest } from './pending-host-task.js';
import type { RepositoryTaskCheckout } from './repository-task-checkout.js';
import type { AccountBinding } from '@mitzo/protocol';
import type { CodexNativeTurnTarget } from './codex-conversation-store.js';
import type { PreparedRepositoryBarrierReadScope } from './prepared-repository-barrier-read.js';

/** Private custody evidence, never a model input, permission grant or admission.
 * Native verifies the durable successful tool result and completed terminal
 * independently. The request identifies the historical Prepare owner only. */
export interface PreparedRepositoryTransitionFacts {
  readonly version: 'prepared-repository-transition-v1';
  readonly request: Readonly<PendingHostTaskRequest>;
  readonly oldWorkspace: Readonly<{
    kind: 'ordinary' | 'repository';
    id: string;
    directory: string;
  }>;
  readonly newWorkspace: Readonly<{
    kind: 'repository';
    id: string;
    directory: string;
    featureBranch: string;
    baseOid: string;
    taskIdentity: Readonly<RepositoryTaskCheckout>;
  }>;
  readonly consumedScopeSha256: string;
  readonly materializedRecordSha256: string;
  /** sha256(JSON.stringify(normalizeCodexToolResult(actual persisted replay))).
   * Supplied by the existing durable native result owner, including content,
   * isError and contentItems; never inferred from planned response text. */
  readonly resultSha256: string;
}

/** Produced and retained by the repository custody owner. The eventual producer
 * must freeze its facts and retain the fresh barrier owner, not an expired
 * Prepare closure. These interfaces do not themselves expose that producer. */
export interface PreparedRepositoryTransitionProof {
  readonly facts: Readonly<PreparedRepositoryTransitionFacts>;
  assertCurrentSync(): void;
  revalidate(): Promise<void>;
  /** One-shot custody CAS after native reserves this exact child UNCERTAIN.
   * Rechecks the current owner and absence of queued old-workspace commands at
   * the boundary. Reservation is not admission; uncertainty never replays CAS. */
  adopt(childCommandId: string): Promise<void>;
}

/** Exact trusted completed-turn selector. A model/client preparation ID or path
 * cannot select a repository row. More than one matching candidate must refuse. */
export interface PreparedRepositoryTransitionCaptureInput {
  readonly binding: Readonly<AccountBinding>;
  readonly conversationId: string;
  readonly sourceTarget: Readonly<CodexNativeTurnTarget>;
  readonly oldWorkspace: PreparedRepositoryTransitionFacts['oldWorkspace'];
}

export interface PreparedRepositoryTransitionCaptureOwners {
  /** Retain the actual fresh scope object through verification AND adoption.
   * No copied facets, default roots or completed Prepare closure substitute. */
  readonly readScope: PreparedRepositoryBarrierReadScope;
  assertNoQueuedOldWorkspaceCommandsSync(): void;
  /** Existing durable native owner validates the exact successful persisted
   * result/call/requestHash/ACK/completed terminal, then returns its digest. */
  resultSha256(request: Readonly<PendingHostTaskRequest>): string;
}

/** Join the original approval/result commitments across independently owned ledgers.
 * Neither ledger's internally valid hashes can substitute for this exact match. */
export function assertPreparedRepositoryAdmissionFacts(
  facts: PreparedRepositoryTransitionFacts,
  anchor: ReturnType<EventStore['observePreparedRepositoryContinuation']>,
  conversationId: string,
  binding: AccountBinding,
): void {
  const transition = anchor.preparedRepositoryTransition;
  if (
    !transition ||
    facts.request.conversationId !== conversationId ||
    !isDeepStrictEqual(facts.request.binding, binding) ||
    !isDeepStrictEqual(anchor.binding, facts.request.runtimeBinding) ||
    !isDeepStrictEqual(transition.source, {
      ...facts.request.nativeTarget,
      callId: facts.request.prepareCallId,
      requestHash: facts.request.requestHash,
      resultSha256: facts.resultSha256,
    }) ||
    !isDeepStrictEqual(transition.oldWorkspace, facts.oldWorkspace) ||
    transition.newWorkspace.id !== facts.newWorkspace.id ||
    transition.newWorkspace.directory !== facts.newWorkspace.directory ||
    transition.newWorkspace.featureBranch !== facts.newWorkspace.featureBranch ||
    transition.newWorkspace.baseOid !== facts.newWorkspace.baseOid ||
    transition.newWorkspace.taskIdentitySha256 !==
      createHash('sha256').update(JSON.stringify(facts.newWorkspace.taskIdentity)).digest('hex') ||
    transition.consumedScopeSha256 !== facts.consumedScopeSha256 ||
    transition.materializedRecordSha256 !== facts.materializedRecordSha256
  )
    throw Error('Prepared repository recovery evidence changed');
}
