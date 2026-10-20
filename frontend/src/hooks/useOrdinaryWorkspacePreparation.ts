import { useEffect, useMemo, useRef, useState } from 'react';
import { OrdinaryWorkspaceApiClient } from '@mitzo/client';
import type {
  OrdinaryWorkspacePreparationRequest,
  OrdinaryWorkspacePreparationReceipt,
} from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';
import {
  loadOrdinaryPreparation,
  retainOrdinaryPreparation,
  validateOrdinaryPreparation,
  type RetainedOrdinaryPreparation,
} from '../lib/ordinary-workspace-preparation';
type State = {
  draftId: string;
  retained: RetainedOrdinaryPreparation | null;
  unreadable: boolean;
  pending: boolean;
  error?: string;
  selectionKey?: string;
  failedAttempt?: number;
  candidate?: OrdinaryWorkspacePreparationReceipt;
};
function load(draftId: string): State {
  try {
    return {
      draftId,
      retained: loadOrdinaryPreparation(draftId),
      unreadable: false,
      pending: false,
    };
  } catch {
    return {
      draftId,
      retained: null,
      unreadable: true,
      pending: false,
      error:
        'The saved workspace preparation could not be read. Preserve this draft and its original role request.',
    };
  }
}
/** Silent readiness only; the role hook retains allocation/recovery ownership. */
export function useOrdinaryWorkspacePreparation(options: {
  draftId: string;
  enabled: boolean;
  request: OrdinaryWorkspacePreparationRequest | null;
  selectionKey: string;
  blocked: boolean;
}) {
  const seed = useMemo(() => load(options.draftId), [options.draftId]);
  const [state, setState] = useState(seed);
  const view = state.draftId === options.draftId ? state : seed;
  const [attempt, setAttempt] = useState(0);
  const latest = useRef({ ...options, view });
  latest.current = { ...options, view };
  const api = useMemo(() => new OrdinaryWorkspaceApiClient(apiFetch), []);
  useEffect(() => {
    const scope = latest.current;
    if (
      !scope.enabled ||
      !scope.request ||
      scope.blocked ||
      scope.view.unreadable ||
      scope.view.retained?.selectionKey === scope.selectionKey ||
      (scope.view.selectionKey === scope.selectionKey && scope.view.failedAttempt === attempt)
    )
      return;
    const abort = new AbortController();
    const active = () =>
      !abort.signal.aborted &&
      latest.current.draftId === scope.draftId &&
      latest.current.selectionKey === scope.selectionKey &&
      !latest.current.blocked;
    setState({ ...scope.view, pending: true, error: undefined, selectionKey: scope.selectionKey });
    void (async () => {
      let candidate =
        scope.view.selectionKey === scope.selectionKey ? scope.view.candidate : undefined;
      let scoped = false;
      try {
        candidate ??= await api.prepare(scope.request!, abort.signal);
        if (!active()) return;
        const validated = validateOrdinaryPreparation({
          version: 1,
          draftId: scope.draftId,
          selectionKey: scope.selectionKey,
          request: scope.request!,
          receipt: candidate,
        });
        scoped = true;
        const retained = retainOrdinaryPreparation(validated);
        setState({ draftId: scope.draftId, retained, unreadable: false, pending: false });
      } catch (error) {
        if (active())
          setState({
            ...scope.view,
            pending: false,
            selectionKey: scope.selectionKey,
            failedAttempt: attempt,
            candidate: scoped ? candidate : undefined,
            error: scoped
              ? 'The original workspace preparation could not be saved. Your draft is retained; check again to retain the same preparation.'
              : error instanceof Error
                ? error.message
                : 'Workspace readiness is unavailable. Your draft is retained.',
          });
      }
    })();
    return () => abort.abort();
  }, [options.draftId, options.enabled, options.selectionKey, options.blocked, attempt, api]);
  return {
    receipt: view.retained?.selectionKey === options.selectionKey ? view.retained.receipt : null,
    pending: !options.blocked && view.pending && view.selectionKey === options.selectionKey,
    error: view.unreadable || view.selectionKey === options.selectionKey ? view.error : undefined,
    retry: () => setAttempt((value) => value + 1),
  };
}
