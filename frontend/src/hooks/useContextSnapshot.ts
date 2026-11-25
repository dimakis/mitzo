import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ContextSnapshotResponseSchema,
  contextSnapshotScopeKey,
  type ContextSnapshotResponse,
} from '@mitzo/protocol';
import { apiFetch, AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from '../lib/api-fetch';
import { createBrowserId } from '../lib/browser-crypto';

type ReadState = {
  response?: ContextSnapshotResponse;
  pending: boolean;
  error?: string;
  revoked?: boolean;
};

/** One inspection lifetime. The authenticated endpoint establishes the initial
 * native binding; refreshes cannot replace it in an already open inspection.
 * Neither a snapshot nor this local fence grants authority to the host. */
export function useContextSnapshot(sessionId: string, open: boolean, onDismiss: () => void) {
  const [state, setState] = useState<ReadState>({ pending: true });
  const active = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const retained = useRef<ContextSnapshotResponse | undefined>(undefined);
  const binding = useRef<string | undefined>(undefined);
  const revoked = useRef(false);

  const cancel = useCallback(() => {
    generation.current++;
    active.current?.abort();
  }, []);

  const request = useCallback(
    async (detail?: 'summary' | 'full') => {
      if (!open || revoked.current) return;
      cancel();
      const epoch = generation.current;
      const controller = new AbortController();
      active.current = controller;
      setState({ pending: true });
      // Includes reading/parsing the body. No retry, polling or full fallback.
      const deadline = setTimeout(() => {
        if (generation.current !== epoch) return;
        cancel();
        setState({
          pending: false,
          error:
            detail === 'full'
              ? 'Full inspection timed out. Token-count work may have occurred. Nothing was retried.'
              : 'Context inspection timed out. Read the snapshot again when ready.',
        });
      }, 10_000);
      try {
        const response = await apiFetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/context-snapshot${detail ? '/refresh' : ''}`,
          {
            method: detail ? 'POST' : 'GET',
            signal: controller.signal,
            cache: 'no-store',
            ...(detail
              ? {
                  headers: {
                    'Content-Type': 'application/json',
                    'X-Mitzo-Context-Intent': `refresh-${detail}`,
                  },
                  body: JSON.stringify({
                    requestId: createBrowserId(),
                    detail,
                    ...(detail === 'full' ? { allowTokenCount: true } : {}),
                  }),
                }
              : {}),
          },
        );
        if (controller.signal.aborted || generation.current !== epoch) return;
        if (response.status === 401 || response.status === 403) {
          revoked.current = true;
          retained.current = undefined;
          binding.current = undefined;
          setState({
            pending: false,
            revoked: true,
            error:
              'Context access is no longer available. Close this inspection and verify access before reopening.',
          });
          return;
        }
        if (!response.ok) throw new Error('http_failed');
        const parsed = ContextSnapshotResponseSchema.safeParse(await response.json());
        if (controller.signal.aborted || generation.current !== epoch) return;
        if (!parsed.success) throw new Error('invalid_response');
        const next = parsed.data;
        const snapshot = next.snapshot;
        if (next.sessionId !== sessionId || (snapshot && snapshot.identity.scope !== 'parent'))
          throw new Error('scope_mismatch');
        const scope = snapshot ? contextSnapshotScopeKey(snapshot) : undefined;
        if (scope && binding.current && scope !== binding.current) throw new Error('scope_changed');
        const previous = retained.current;
        if (
          previous &&
          (next.revision < previous.revision ||
            (snapshot && previous.snapshot && snapshot.observedAt < previous.snapshot.observedAt))
        )
          throw new Error('out_of_order');
        if (next.reason === 'authority_expired') {
          revoked.current = true;
          retained.current = undefined;
          binding.current = undefined;
          setState({ pending: false, revoked: true, response: { ...next, snapshot: undefined } });
          return;
        }
        binding.current = scope ?? binding.current;
        retained.current = next;
        setState({ pending: false, response: next });
      } catch (cause) {
        if (controller.signal.aborted || generation.current !== epoch) return;
        const code =
          cause instanceof Error &&
          [
            'http_failed',
            'invalid_response',
            'scope_mismatch',
            'scope_changed',
            'out_of_order',
          ].includes(cause.message)
            ? cause.message
            : 'read_failed';
        console.warn('Context snapshot inspection failed', {
          code: `context_snapshot_${code}`,
          stage: detail ? 'refresh' : 'read',
          sessionId,
          cause: cause instanceof Error ? cause.name : typeof cause,
        });
        setState({
          pending: false,
          error:
            code === 'scope_changed' || code === 'out_of_order'
              ? 'Context changed while inspecting. Close and reopen to read the current binding.'
              : detail === 'full'
                ? 'Full inspection could not be confirmed. Token-count work may have occurred. Nothing was retried.'
                : 'Context snapshot could not be read or validated. Read again when ready.',
        });
      } finally {
        clearTimeout(deadline);
      }
    },
    [sessionId, open, cancel],
  );

  useEffect(() => {
    retained.current = undefined;
    binding.current = undefined;
    revoked.current = false;
    if (open) void request();
    else setState({ pending: true });
    return cancel;
  }, [open, request, cancel]);

  useEffect(() => {
    const invalidate = () => {
      cancel();
      revoked.current = true;
      retained.current = undefined;
      binding.current = undefined;
      setState({ pending: false, revoked: true });
      onDismiss();
    };
    window.addEventListener(AUTH_LOST_EVENT, invalidate);
    window.addEventListener(AUTH_RESTORED_EVENT, invalidate);
    return () => {
      window.removeEventListener(AUTH_LOST_EVENT, invalidate);
      window.removeEventListener(AUTH_RESTORED_EVENT, invalidate);
    };
  }, [cancel, onDismiss]);

  return { ...state, request };
}
