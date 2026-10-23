import type { PendingHostTaskRequest } from './pending-host-task.js';
import type { RepositoryTaskCheckout } from './repository-task-checkout.js';

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
