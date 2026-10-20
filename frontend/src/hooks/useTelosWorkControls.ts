import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { TelosWorkApiClient, TelosWorkApiError } from '@mitzo/client';
import {
  TelosWorkControlCommandSchema,
  TelosWorkIdSchema,
  type TelosWorkControlCommand,
  type TelosWorkControlView,
} from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import { createBrowserId } from '../lib/browser-crypto';
import { eventBus } from '../lib/event-bus-singleton';

const api = new TelosWorkApiClient(apiFetch);
type Mutation = Extract<TelosWorkControlCommand, { operation: 'request' | 'release' }>;
type NewMutation =
  | Omit<Extract<Mutation, { operation: 'request' }>, 'requestId'>
  | Omit<Extract<Mutation, { operation: 'release' }>, 'requestId'>;
const savedSchema = z
  .strictObject({
    version: z.literal(1),
    itemId: TelosWorkIdSchema,
    command: TelosWorkControlCommandSchema,
  })
  .superRefine((value, context) => {
    if (
      !['request', 'release'].includes(value.command.operation) ||
      (value.command.operation === 'request' && value.command.coordinatorItemId !== value.itemId)
    )
      context.addIssue({ code: 'custom', message: 'Original item-bound control request required' });
  });
type Pending = { itemId: string; command: Mutation; status: 'sending' | 'uncertain' | 'refused' };
const key = (id: string) => `telos.control.pending.${id}`;
function restore(id: string): Pending | null {
  const raw = sessionStorage.getItem(key(id));
  if (!raw) return null;
  const saved = savedSchema.parse(JSON.parse(raw));
  if (saved.itemId !== id) throw Error('Original control request identity changed');
  return { itemId: id, command: saved.command as Mutation, status: 'uncertain' };
}
/** Durable controls stay on the server. Session storage retains only an exact
 * retry envelope; it grants no authority and is never submitted automatically. */
export function useTelosWorkControls(itemId: string, refreshKey: string | number) {
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    itemId: string;
    controls: TelosWorkControlView[];
    current: boolean;
    error: string;
  }>({ itemId, controls: [], current: false, error: '' });
  const [pending, setPending] = useState<Pending | null>(null);
  const [recoveryError, setRecoveryError] = useState('');
  const [busy, setBusy] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const readOperation = useRef<AbortController | null>(null);
  useEffect(() => {
    setBusy(false);
    try {
      setPending(restore(itemId));
      setRecoveryError('');
    } catch {
      setRecoveryError(
        'Retained control request unavailable. Inspect receipts before another request.',
      );
    }
    return () => {
      operation.current?.abort();
      operation.current = null;
      readOperation.current?.abort();
    };
  }, [itemId]);
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    const off = eventBus.on('todo_update', refresh);
    const connected = eventBus.onConnectionChange((value) => {
      if (value) refresh();
    });
    const resume = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', resume);
    return () => {
      off();
      connected();
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    readOperation.current?.abort();
    readOperation.current = controller;
    setSnapshot((old) => ({
      itemId,
      controls: old.itemId === itemId ? old.controls : [],
      current: false,
      error: '',
    }));
    void api
      .control({ operation: 'inbox', itemId }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted && Array.isArray(result))
          setSnapshot({ itemId, controls: result, current: true, error: '' });
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setSnapshot((old) => ({
            ...old,
            current: false,
            error: cause instanceof Error ? cause.message : 'Control receipts unavailable',
          }));
      });
    return () => controller.abort();
  }, [itemId, refreshKey, revision]);
  const current = snapshot.itemId === itemId && snapshot.current && !recoveryError;
  const activePending = pending?.itemId === itemId ? pending : null;
  async function submit(command: Mutation) {
    if (!current || operation.current) return;
    try {
      const encoded = JSON.stringify({ version: 1, itemId, command });
      savedSchema.parse(JSON.parse(encoded));
      sessionStorage.setItem(key(itemId), encoded);
      if (sessionStorage.getItem(key(itemId)) !== encoded)
        throw Error('Retry envelope was not retained');
    } catch {
      setSnapshot((old) => ({
        ...old,
        error: 'Could not retain the original retry identity. No control request was sent.',
      }));
      return;
    }
    const controller = new AbortController();
    operation.current = controller;
    setPending({ itemId, command, status: 'sending' });
    setBusy(true);
    setSnapshot((old) => ({ ...old, error: '' }));
    try {
      const receipt = await api.control(command, controller.signal);
      if (controller.signal.aborted || Array.isArray(receipt)) return;
      sessionStorage.removeItem(key(itemId));
      setPending(null);
      setSnapshot((old) => ({
        itemId,
        controls: [
          ...old.controls.filter((value) => value.controlId !== receipt.controlId),
          receipt,
        ],
        current: false,
        error: '',
      }));
      setRevision((value) => value + 1);
    } catch (cause) {
      if (controller.signal.aborted) return;
      const refused =
        cause instanceof TelosWorkApiError && [400, 401, 403, 404, 409].includes(cause.status);
      setPending({ itemId, command, status: refused ? 'refused' : 'uncertain' });
      setSnapshot((old) => ({
        ...old,
        error: refused
          ? cause.message
          : 'Control delivery is uncertain. Check retained receipts or retry the original request.',
      }));
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        if (!controller.signal.aborted) setBusy(false);
      }
    }
  }
  return {
    controls: snapshot.itemId === itemId ? snapshot.controls : [],
    current,
    busy,
    error: recoveryError || (snapshot.itemId === itemId ? snapshot.error : ''),
    pending: activePending,
    refresh: () => setRevision((value) => value + 1),
    send: async (command: NewMutation) => {
      if (!activePending) await submit({ ...command, requestId: createBrowserId() } as Mutation);
    },
    retry: async () => {
      if (activePending) await submit(activePending.command);
    },
    discardRefused: () => {
      if (activePending?.status === 'refused') {
        try {
          sessionStorage.removeItem(key(itemId));
          setPending(null);
        } catch {
          setRecoveryError('Retained control request could not be cleared.');
        }
      }
    },
    read: async (controlId: string) => {
      const controller = new AbortController();
      readOperation.current?.abort();
      readOperation.current = controller;
      try {
        const receipt = await api.control({ operation: 'read', controlId }, controller.signal);
        if (!controller.signal.aborted && !Array.isArray(receipt))
          setSnapshot((old) => ({
            itemId,
            controls: [...old.controls.filter((value) => value.controlId !== controlId), receipt],
            current: true,
            error: '',
          }));
      } catch (cause) {
        if (!controller.signal.aborted)
          setSnapshot((old) => ({
            ...old,
            current: false,
            error: cause instanceof Error ? cause.message : 'Current receipt unavailable',
          }));
      }
    },
  };
}
