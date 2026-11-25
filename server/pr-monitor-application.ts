import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PrMonitorSubscription, AccountBinding } from '@mitzo/protocol';
import type { SessionRegistry } from '@mitzo/harness';
import type { EventStore } from './event-store.js';
import type { ConnectionStore } from './connections-store.js';
import { createPrMonitorController } from './pr-monitor-controller.js';

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
  } catch {
    throw Error('conversation_unavailable');
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
      if (
        !runtime ||
        runtime.store.pendingAssignments().some((r) => r.connectionId === id) ||
        runtime.store.pendingProbes().some((r) => r.connectionId === id) ||
        runtime.store.candidates().some((r) => r.connectionId === id)
      )
        return undefined;
      return runtime.store.get(id) ?? undefined;
    },
  });
}
