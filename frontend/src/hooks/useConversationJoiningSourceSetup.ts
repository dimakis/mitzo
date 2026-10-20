import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MitzoApiClient } from '@mitzo/client';
import {
  CollaborationSourceSetupQuerySchema,
  type CollaborationSourceSetup,
} from '@mitzo/protocol';
import {
  apiFetch,
  AUTH_LOST_EVENT,
  AUTH_RESTORED_EVENT,
  currentVerifiedAuthSessionId,
  getApiBaseUrl,
} from '../lib/api-fetch';

// The existing transport owns cookies, bearer injection and the application base.
// This client creates neither a store nor a connection or authentication registry.
const api = new MitzoApiClient(apiFetch);
const unavailable = {
  multiple_associations:
    'This chat belongs to more than one shared conversation. Fresh agents are unavailable here.',
  origin_unverified: 'Fresh agent setup could not be verified for this conversation.',
  foreign_origin:
    'This shared conversation started in another chat. Fresh agents are unavailable here.',
} satisfies Record<Extract<CollaborationSourceSetup, { state: 'unavailable' }>['reason'], string>;

/** Observational canonical selection only. Opening a page never begins a group,
 * prepares a workspace, installs joining authority or starts an agent response. */
export function useConversationJoiningSourceSetup(options: {
  sourceConversationId: string | null;
  clientId: string | null | undefined;
}) {
  const { sourceConversationId, clientId } = options;
  const [login, setLogin] = useState(currentVerifiedAuthSessionId);
  const [loginEpoch, setLoginEpoch] = useState(0);
  const readEpoch = useRef(0);
  const base = getApiBaseUrl();
  const [attempt, setAttempt] = useState(0);
  const currentAttempt = useRef(0);
  const owner = useMemo(
    () => ({ sourceConversationId, clientId, login, base, attempt, loginEpoch }),
    [sourceConversationId, clientId, login, base, attempt, loginEpoch],
  );
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const valid =
    !!login &&
    CollaborationSourceSetupQuerySchema.safeParse({ sourceConversationId, clientId }).success;
  const [result, setResult] = useState<{
    owner: typeof owner;
    data: CollaborationSourceSetup | null;
    error: string | null;
  }>();
  useEffect(() => {
    let active = true;
    const invalidate = () => {
      setLoginEpoch(++readEpoch.current);
      setResult(undefined);
      setLogin(undefined);
      // Existing restoration announces before publishing its final verified ID.
      // This only re-reads that owner's proof; it never mints a login identity.
      queueMicrotask(() => {
        if (active) setLogin(currentVerifiedAuthSessionId());
      });
    };
    window.addEventListener(AUTH_LOST_EVENT, invalidate);
    window.addEventListener(AUTH_RESTORED_EVENT, invalidate);
    return () => {
      active = false;
      window.removeEventListener(AUTH_LOST_EVENT, invalidate);
      window.removeEventListener(AUTH_RESTORED_EVENT, invalidate);
    };
  }, []);
  useEffect(() => {
    const query = CollaborationSourceSetupQuerySchema.safeParse({
      sourceConversationId: owner.sourceConversationId,
      clientId: owner.clientId,
    });
    if (!valid || !query.success) return;
    const controller = new AbortController();
    const epoch = readEpoch.current;
    let active = true;
    const current = () =>
      active &&
      !controller.signal.aborted &&
      currentOwner.current === owner &&
      readEpoch.current === epoch &&
      currentAttempt.current === owner.attempt &&
      currentVerifiedAuthSessionId() === owner.login &&
      getApiBaseUrl() === owner.base;
    void (async () => {
      try {
        if (!current()) return;
        const data = await api.collaborations.sourceSetup(
          query.data.sourceConversationId,
          query.data.clientId,
          controller.signal,
        );
        if (current()) setResult({ owner, data, error: null });
      } catch {
        if (current())
          setResult({
            owner,
            data: null,
            error: 'Fresh agent setup could not be checked. Your setup stays here.',
          });
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [owner, valid]);
  const visible =
    valid &&
    currentVerifiedAuthSessionId() === login &&
    getApiBaseUrl() === base &&
    result?.owner === owner
      ? result
      : undefined;
  const loading = valid && !visible;
  const data = visible?.data ?? null;
  const reason = !valid
    ? 'Reconnect to check fresh-agent setup.'
    : loading
      ? 'Checking fresh-agent setup…'
      : (visible?.error ?? (data?.state === 'unavailable' ? unavailable[data.reason] : undefined));
  // Retire a confirmed read synchronously, before React publishes the next
  // attempt. Action callbacks must not use it in that interval.
  const refresh = useCallback(() => setAttempt(++currentAttempt.current), []);
  const currentSourceSetup = useCallback(
    () =>
      valid &&
      currentOwner.current === owner &&
      readEpoch.current === owner.loginEpoch &&
      currentAttempt.current === owner.attempt &&
      currentVerifiedAuthSessionId() === owner.login &&
      getApiBaseUrl() === owner.base &&
      result?.owner === owner
        ? result.data
        : null,
    [valid, owner, result],
  );
  return {
    sourceSetup: data,
    currentSourceSetup,
    loading,
    reason,
    canRefresh: valid && (!!visible?.error || data?.state === 'unavailable'),
    refresh,
  };
}
