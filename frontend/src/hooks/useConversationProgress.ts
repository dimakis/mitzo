import { useEffect, useMemo, useState } from 'react';
import type { CollaborationApiClient } from '@mitzo/client';
import type { CollaborationProgress, CollaborationView } from '@mitzo/protocol';
import { AUTH_LOST_EVENT, AUTH_RESTORED_EVENT } from '../lib/api-fetch';

/** Observes host-authorized visible text only; never subscribes to private
 * participant transports, sends a prompt or changes ordinary recovery. */
export function useConversationProgress(options: {
  api: CollaborationApiClient;
  view?: CollaborationView;
  authScope?: string;
  getVerifiedAuthScope(): string | undefined;
  refreshTranscript(): Promise<unknown>;
}) {
  const { api, view, authScope, getVerifiedAuthScope, refreshTranscript } = options;
  const group = view?.collaborationId;
  const membership = view?.membershipRevision;
  const audience = JSON.stringify([
    view?.participantSessionIds,
    view?.unavailableParticipantSessionIds,
  ]);
  const owner = useMemo(
    () => ({
      api,
      group,
      membership,
      audience,
      authScope,
      getVerifiedAuthScope,
      refreshTranscript,
    }),
    [api, group, membership, audience, authScope, getVerifiedAuthScope, refreshTranscript],
  );
  const [state, setState] = useState<{
    owner: object;
    progress?: CollaborationProgress;
    error?: string;
  }>({ owner });
  useEffect(() => {
    let alive = true;
    let reading: object | undefined;
    let blocked = false;
    let epoch = 0;
    let controller = new AbortController();
    const valid = () =>
      alive && !blocked && !!group && !!authScope && getVerifiedAuthScope() === authScope;
    const lost = () => {
      blocked = true;
      epoch++;
      controller.abort();
      reading = undefined;
      if (alive) setState({ owner });
    };
    setState({ owner });
    const read = async () => {
      if (reading || !valid() || controller.signal.aborted) return;
      const operation = {};
      reading = operation;
      const generation = epoch;
      const requestController = controller;
      const fresh = () => valid() && epoch === generation && !requestController.signal.aborted;
      try {
        const progress = await api.progress(group!, requestController.signal);
        if (!fresh()) return;
        if (progress.collaborationId !== group)
          throw Error('The conversation changed. Refresh before reading live replies.');
        if (progress.membershipRevision !== membership) {
          // Discard this audience's live material, then renew the independently
          // authorized view. Otherwise a remote membership change would leave
          // this observer rejecting every later sample against its stale view.
          setState({
            owner,
            error: 'The conversation changed. Refresh before reading live replies.',
          });
          await refreshTranscript();
          return;
        }
        setState({ owner, progress });
        // Every authorized sample also checks durable finalized replies. A fast
        // turn can finish entirely between samples, so disappearance alone is
        // insufficient. This read never depends on a local send journal.
        await refreshTranscript();
      } catch (cause) {
        if (fresh())
          setState({
            owner,
            error:
              cause instanceof Error
                ? cause.message
                : 'Live replies are unavailable. Check the original request.',
          });
      } finally {
        if (reading === operation) reading = undefined;
      }
    };
    const restored = () => {
      const generation = epoch;
      queueMicrotask(() => {
        // Existing login restoration publishes verified scope synchronously after
        // its event. This observes that proof; it never starts authentication.
        if (!alive || generation !== epoch || !authScope || getVerifiedAuthScope() !== authScope)
          return;
        epoch++;
        controller.abort();
        controller = new AbortController();
        reading = undefined;
        blocked = false;
        void read();
      });
    };
    void read();
    const timer = window.setInterval(() => void read(), 1500);
    window.addEventListener(AUTH_LOST_EVENT, lost);
    window.addEventListener(AUTH_RESTORED_EVENT, restored);
    return () => {
      alive = false;
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener(AUTH_LOST_EVENT, lost);
      window.removeEventListener(AUTH_RESTORED_EVENT, restored);
    };
  }, [owner, api, group, membership, authScope, getVerifiedAuthScope, refreshTranscript]);
  return state.owner === owner && getVerifiedAuthScope() === authScope ? state : { owner };
}
