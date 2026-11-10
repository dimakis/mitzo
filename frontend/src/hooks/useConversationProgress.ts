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
}) {
  const { api, view, authScope, getVerifiedAuthScope } = options;
  const group = view?.collaborationId;
  const membership = view?.membershipRevision;
  const audience = JSON.stringify([
    view?.participantSessionIds,
    view?.unavailableParticipantSessionIds,
  ]);
  const owner = useMemo(
    () => ({ api, group, membership, audience, authScope, getVerifiedAuthScope }),
    [api, group, membership, audience, authScope, getVerifiedAuthScope],
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
        if (progress.membershipRevision !== membership)
          throw Error('The conversation changed. Refresh before reading live replies.');
        setState({ owner, progress });
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
  }, [owner, api, group, membership, authScope, getVerifiedAuthScope]);
  return state.owner === owner && getVerifiedAuthScope() === authScope ? state : { owner };
}
