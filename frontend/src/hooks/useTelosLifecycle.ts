import { useEffect, useRef, useState } from 'react';
import { TelosWorkApiClient, TelosWorkApiError } from '@mitzo/client';
import {
  TelosWorkLifecycleCommandSchema,
  type TelosWorkLifecycleCommand,
  type TelosWorkLifecycleView,
} from '@mitzo/protocol';
import {
  apiFetch,
  currentVerifiedAuthSessionId,
  getApiBaseUrl,
  AUTH_LOST_EVENT,
  AUTH_RESTORED_EVENT,
} from '../lib/api-fetch';
import { createBrowserId } from '../lib/browser-crypto';
import { eventBus } from '../lib/event-bus-singleton';
import {
  notifyTodoLifecycleChange,
  subscribeTodoLifecycleUpdates,
} from '../lib/todo-lifecycle-events';
const api = new TelosWorkApiClient(apiFetch);
type Pending = {
  scope: string;
  command: TelosWorkLifecycleCommand;
  status: 'sending' | 'uncertain' | 'refused' | 'recorded';
};
type Operation = TelosWorkLifecycleCommand['operation'];
type Confirmation = { itemId: string; phrase: 'DELETE PERMANENTLY' };
function verifiedScope(): string | null {
  const identity = currentVerifiedAuthSessionId();
  return identity ? JSON.stringify([getApiBaseUrl(), identity]) : null;
}
const key = (id: string, scope: string) =>
  'telos.lifecycle.pending.' + encodeURIComponent(scope) + '.' + encodeURIComponent(id);
function restore(id: string, scope: string): Pending | null {
  const raw = sessionStorage.getItem(key(id, scope));
  if (!raw) return null;
  const command = TelosWorkLifecycleCommandSchema.parse(JSON.parse(raw));
  if (
    command.itemId !== id ||
    (command.operation === 'delete_permanently' && command.confirmation.itemId !== id)
  )
    throw Error('Retained lifecycle request identity changed');
  return { scope, command, status: 'uncertain' };
}
/** The server owns lifecycle. This hook retains only an exact explicit-retry
 * envelope; neither mounting, refresh nor reconnect submits a mutation. */
export function useTelosLifecycle(
  itemId: string,
  refreshKey: string | number,
  onDeleted?: () => void,
) {
  const [authScope, setAuthScope] = useState(verifiedScope);
  const [serial, setSerial] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    itemId: string;
    scope: string | null;
    lifecycle: TelosWorkLifecycleView | null;
    current: boolean;
    error: string;
  }>({ itemId, scope: authScope, lifecycle: null, current: false, error: '' });
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState('');
  const [recoveryBlocked, setRecoveryBlocked] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [deletedId, setDeletedId] = useState<string | null>(null);
  const route = useRef(itemId);
  route.current = itemId;
  const mutation = useRef<AbortController | null>(null);
  const read = useRef<AbortController | null>(null);
  const readReady = useRef(false);
  useEffect(() => {
    setBusy(false);
    setError('');
    setRecoveryBlocked(false);
    readReady.current = false;
    setNotice('');
    setDeletedId(null);
    try {
      setPending(authScope ? restore(itemId, authScope) : null);
    } catch {
      setPending(null);
      setRecoveryBlocked(true);
      setError(
        'Retained lifecycle request unavailable. Review current state before another request.',
      );
    }
    return () => {
      mutation.current?.abort();
      mutation.current = null;
      read.current?.abort();
    };
  }, [itemId, authScope]);
  useEffect(() => {
    const changeIdentity = (restored: boolean) => {
      readReady.current = false;
      read.current?.abort();
      mutation.current?.abort();
      mutation.current = null;
      setBusy(false);
      setSnapshot({
        itemId: route.current,
        scope: null,
        lifecycle: null,
        current: false,
        error: '',
      });
      setAuthScope(restored ? verifiedScope() : null);
      setSerial((value) => value + 1);
    };
    const lost = () => changeIdentity(false);
    const restored = () => changeIdentity(true);
    window.addEventListener(AUTH_LOST_EVENT, lost);
    window.addEventListener(AUTH_RESTORED_EVENT, restored);
    return () => {
      window.removeEventListener(AUTH_LOST_EVENT, lost);
      window.removeEventListener(AUTH_RESTORED_EVENT, restored);
    };
  }, []);
  useEffect(() => {
    const invalidate = () => {
      readReady.current = false;
      setSnapshot((old) => ({ ...old, current: false }));
      read.current?.abort();
      setSerial((value) => value + 1);
    };
    const off = eventBus.on('todo_update', invalidate);
    const lifecycleUpdate = subscribeTodoLifecycleUpdates(invalidate);
    const connected = eventBus.onConnectionChange((value) => {
      if (value) invalidate();
    });
    const resume = () => {
      if (document.visibilityState === 'visible') invalidate();
    };
    document.addEventListener('visibilitychange', resume);
    return () => {
      off();
      lifecycleUpdate();
      connected();
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);
  useEffect(() => {
    if (!authScope || verifiedScope() !== authScope || deletedId === itemId) return;
    const controller = new AbortController();
    readReady.current = false;
    read.current?.abort();
    read.current = controller;
    setSnapshot((old) => ({
      itemId,
      scope: authScope,
      lifecycle: old.itemId === itemId && old.scope === authScope ? old.lifecycle : null,
      current: false,
      error: '',
    }));
    void api
      .readLifecycle(itemId, controller.signal)
      .then((value) => {
        if (controller.signal.aborted || route.current !== itemId || verifiedScope() !== authScope)
          return;
        if (value.itemId !== itemId)
          throw Error('Lifecycle identity differs from the selected item');
        readReady.current = true;
        setSnapshot({ itemId, scope: authScope, lifecycle: value, current: true, error: '' });
      })
      .catch((cause) => {
        if (!controller.signal.aborted && route.current === itemId && verifiedScope() === authScope)
          setSnapshot((old) => ({
            ...old,
            current: false,
            error: cause instanceof Error ? cause.message : 'Lifecycle unavailable',
          }));
      });
    return () => controller.abort();
  }, [itemId, refreshKey, serial, deletedId, authScope]);
  const sameScope = !!authScope && verifiedScope() === authScope && snapshot.scope === authScope;
  const lifecycle = sameScope && snapshot.itemId === itemId ? snapshot.lifecycle : null;
  const current =
    sameScope && snapshot.itemId === itemId && snapshot.current && deletedId !== itemId;
  const activePending =
    authScope && pending?.scope === authScope && pending.command.itemId === itemId ? pending : null;
  async function submit(command: TelosWorkLifecycleCommand) {
    if (!authScope || verifiedScope() !== authScope || mutation.current || route.current !== itemId)
      return false;
    try {
      sessionStorage.setItem(key(itemId, authScope), JSON.stringify(command));
    } catch {
      setError('Could not retain the exact lifecycle request. Nothing was sent.');
      return false;
    }
    const controller = new AbortController();
    mutation.current = controller;
    readReady.current = false;
    read.current?.abort();
    setBusy(true);
    setError('');
    setNotice('');
    setPending({ scope: authScope, command, status: 'sending' });
    setSnapshot((old) => ({ ...old, current: false }));
    try {
      const receipt = await api.executeLifecycle(command, controller.signal);
      if (controller.signal.aborted || route.current !== itemId || verifiedScope() !== authScope)
        return false;
      try {
        sessionStorage.removeItem(key(itemId, authScope));
        setPending(null);
      } catch {
        setPending({ scope: authScope, command, status: 'recorded' });
        setError('Request recorded. Retained retry data could not be cleared.');
      }
      setNotice(
        command.operation === 'delete_permanently'
          ? 'Item permanently deleted.'
          : 'Lifecycle request recorded.',
      );
      if (receipt.lifecycle === null && command.operation === 'delete_permanently') {
        setDeletedId(itemId);
        // Leave the removed item's route before list invalidation can replace
        // it with the generic missing-item redirect. Retain its exact context.
        try {
          onDeleted?.();
        } catch {
          // Navigation failure cannot turn a validated acknowledgement into an
          // uncertain write or permit a second deletion command.
          console.error('Unable to return from the deleted Telos item');
        }
      } else setSerial((value) => value + 1); // Receipts are historical; re-read current state.
      notifyTodoLifecycleChange();
      return true;
    } catch (cause) {
      if (controller.signal.aborted || route.current !== itemId || verifiedScope() !== authScope)
        return false;
      const refused =
        cause instanceof TelosWorkApiError && [400, 401, 403, 404, 409, 422].includes(cause.status);
      setPending({ scope: authScope, command, status: refused ? 'refused' : 'uncertain' });
      setError(
        refused
          ? cause.message
          : `Delivery is not confirmed. ${cause instanceof Error ? cause.message : 'Retry the original request to recover its receipt.'}`,
      );
      setSerial((value) => value + 1);
      return false;
    } finally {
      if (mutation.current === controller) {
        mutation.current = null;
        if (!controller.signal.aborted && route.current === itemId && verifiedScope() === authScope)
          setBusy(false);
      }
    }
  }
  return {
    authScope,
    lifecycle,
    current,
    recoveryBlocked,
    busy,
    pending: activePending,
    deleted: deletedId === itemId,
    error: !authScope
      ? 'Verified interactive login required to review item controls.'
      : error || (snapshot.itemId === itemId ? snapshot.error : ''),
    notice,
    refresh: () => {
      readReady.current = false;
      setSnapshot((old) => ({ ...old, current: false }));
      read.current?.abort();
      setSerial((value) => value + 1);
    },
    send: async (
      operation: Operation,
      options: { expectedRevision?: string; confirmation?: Confirmation } = {},
    ) => {
      if (!current || !readReady.current || !lifecycle || activePending || recoveryBlocked)
        return false;
      const parsed = TelosWorkLifecycleCommandSchema.safeParse({
        requestId: createBrowserId(),
        itemId,
        expectedRevision: options.expectedRevision ?? lifecycle.revision,
        operation,
        ...(options.confirmation ? { confirmation: options.confirmation } : {}),
      });
      if (
        !parsed.success ||
        (parsed.data.operation === 'delete_permanently' &&
          parsed.data.confirmation.itemId !== itemId)
      ) {
        setError('Permanent deletion requires separate confirmation of this exact item.');
        return false;
      }
      return submit(parsed.data);
    },
    retry: async () =>
      activePending && activePending.status !== 'sending' && activePending.status !== 'refused'
        ? submit(activePending.command)
        : false,
    reviewRecovery: () => {
      if (!authScope || verifiedScope() !== authScope || !recoveryBlocked || !current || busy)
        return;
      try {
        sessionStorage.removeItem(key(itemId, authScope));
        setRecoveryBlocked(false);
        setError('');
        readReady.current = false;
        setSnapshot((old) => ({ ...old, current: false }));
        setSerial((value) => value + 1);
      } catch {
        setError('Retained lifecycle request could not be cleared.');
      }
    },
    reviewRefused: () => {
      if (!authScope || verifiedScope() !== authScope || activePending?.status !== 'refused')
        return;
      try {
        sessionStorage.removeItem(key(itemId, authScope));
        setPending(null);
        setError('');
        readReady.current = false;
        setSnapshot((old) => ({ ...old, current: false }));
        read.current?.abort();
        setSerial((value) => value + 1);
      } catch {
        setError('Retained lifecycle request could not be cleared.');
      }
    },
  };
}
