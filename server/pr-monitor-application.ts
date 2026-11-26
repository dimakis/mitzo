import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PrMonitorSubscription, AccountBinding } from '@mitzo/protocol';
import type { SessionRegistry } from '@mitzo/harness';
import type { EventStore } from './event-store.js';
import type { ConnectionStore } from './connections-store.js';
import { createPrMonitorController } from './pr-monitor-controller.js';

class PrMonitorTransient extends Error {}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Reuse the retained ordinary admission as a read fence, never as permission to
 * reopen a stopped chat or start a provider. No attached browser is required. */
export function readPrMonitorExecution(
  store: EventStore,
  registry: SessionRegistry,
  accounts: { resume(binding: AccountBinding): AccountBinding },
  id: string,
): PrMonitorSubscription['execution'] {
  try {
    store.removals.assertAdmissible(id);
    const meta = store.getSession(id),
      binding = store.getSessionRuntimeBinding(id),
      admission = store.getLatestOrdinaryCommandAdmission(id);
    const live = registry.findBySessionId(id);
    // A turn in flight keeps its admission reserved/uncertain until it completes.
    // That is the normal state while working on the PR in this chat: retry later
    // instead of ending the Watch.
    if (
      meta &&
      !meta.isHidden &&
      admission &&
      (admission.state === 'reserved' || admission.state === 'uncertain')
    )
      throw new PrMonitorTransient('conversation_busy');
    if (
      !meta ||
      meta.isHidden ||
      meta.sessionType === 'symposium' ||
      meta.symposiumConfig ||
      !meta.accountBinding ||
      binding?.version !== 2 ||
      !admission ||
      admission.state !== 'consumed' ||
      !isDeepStrictEqual(binding, admission.binding) ||
      meta.mode !== admission.selection.permission.mode ||
      meta.cwd !== admission.workspace.cwd ||
      (meta.ordinaryWorkspaceId ?? meta.repositoryWorkspaceId) !==
        admission.workspace.workspaceId ||
      (!live && meta.closedBy === 'user') ||
      (live && (registry.isUserClose(live.clientId) || registry.isClosingOut(live.clientId)))
    )
      throw Error('conversation_unavailable');
    const account = accounts.resume(meta.accountBinding);
    if (
      account.accountId !== binding.account.accountId ||
      account.provider !== binding.account.provider ||
      account.profileRevision !== binding.account.profileRevision
    )
      throw Error('conversation_unavailable');
    return {
      binding: structuredClone(binding),
      workspaceId: admission.workspace.workspaceId,
      selectionRevision: digest(admission.selection),
      profileRevision: digest(admission.selection.agent),
    };
  } catch (error) {
    if (error instanceof PrMonitorTransient) throw Error(error.message, { cause: error });
    throw Error('conversation_unavailable', { cause: error });
  }
}
type ControllerOptions = Parameters<typeof createPrMonitorController>[0];
export function createApplicationPrMonitor(options: {
  eventStore: EventStore;
  registry: SessionRegistry;
  accounts(): { resume(binding: AccountBinding): AccountBinding };
  connections(): { store: ConnectionStore } | null;
  auth: ControllerOptions['auth'];
  read: ControllerOptions['read'];
  eligibleAuthors: ControllerOptions['eligibleAuthors'];
}) {
  return createPrMonitorController({
    ...options,
    execution: (id) =>
      readPrMonitorExecution(options.eventStore, options.registry, options.accounts(), id),
    connection: (id) => {
      const runtime = options.connections();
      if (!runtime) return undefined;
      // A pending assignment, probe or candidate is a change in progress, not a
      // lost connection: retry later rather than ending the Watch.
      if (
        runtime.store.pendingAssignments().some((r) => r.connectionId === id) ||
        runtime.store.pendingProbes().some((r) => r.connectionId === id) ||
        runtime.store.candidates().some((r) => r.connectionId === id)
      )
        throw Error('connection_busy');
      return runtime.store.get(id) ?? undefined;
    },
  });
}
