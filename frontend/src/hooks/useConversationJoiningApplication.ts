import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MitzoApiClient } from '@mitzo/client';
import type { CollaborationSourceSetup } from '@mitzo/protocol';
import {
  apiFetch,
  AUTH_LOST_EVENT,
  AUTH_RESTORED_EVENT,
  currentVerifiedAuthSessionId,
  getApiBaseUrl,
} from '../lib/api-fetch';
import { resolveConversationJoiningSource } from '../lib/conversation-joining-source-owner';
import { createPreparedConversationJoiningOwner } from '../lib/conversation-joining-prepared-owner';
import { useConversationJoiningCatalog } from './useConversationJoiningCatalog';
import { useConversationJoiningSourceSetup } from './useConversationJoiningSourceSetup';

const api = new MitzoApiClient(apiFetch);
type Selected = Extract<CollaborationSourceSetup, { state: 'selected' }>;

/** Private page composition. Metadata mounts observationally; only explicit
 * Add begins a relationship and only retained Review stages an ordinary target.
 * No group send/Stop or capacity producer is installed by this hook. */
export function useConversationJoiningApplication(options: {
  sourceConversationId: string | null;
  clientId: string | null | undefined;
  routeKey: string;
  /** Visible ordinary source even while its connected reader is unavailable. */
  ordinarySourceConversationId?: string | null;
}) {
  const source = useConversationJoiningSourceSetup(options);
  const catalog = useConversationJoiningCatalog(options);
  const ordinarySource =
    options.ordinarySourceConversationId === undefined
      ? options.sourceConversationId
      : options.ordinarySourceConversationId;
  const basis = useMemo(
    () => ({ scope: catalog.scope, routeKey: options.routeKey, ordinarySource }),
    [catalog.scope, options.routeKey, ordinarySource],
  );
  const membershipRequired = useRef({ key: '', value: false });
  const membershipScope = JSON.stringify([options.routeKey, ordinarySource, catalog.scope.base]);
  if (membershipRequired.current.key !== membershipScope)
    membershipRequired.current = { key: membershipScope, value: false };
  if (ordinarySource && currentVerifiedAuthSessionId()) membershipRequired.current.value = true;
  const currentBasis = useRef(basis);
  const currentClient = useRef(options.clientId);
  currentClient.current = options.clientId;
  const latestCatalog = useRef(catalog);
  latestCatalog.current = catalog;
  const alive = useRef(true);
  const epoch = useRef(0);
  const authEpoch = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const linked = useRef<object | null>(null);
  const heldShared = useRef<{ key: string; sourceId: string | null; value: boolean }>({
    key: '',
    sourceId: null,
    value: false,
  });
  if (currentBasis.current !== basis) {
    currentBasis.current = basis;
    epoch.current++;
    controller.current?.abort();
    linked.current = null;
  }
  const [action, setAction] = useState<{
    basis: typeof basis;
    epoch: number;
    pending: boolean;
    selected?: Selected;
    error?: string;
  }>();
  const latestAction = useRef(action);
  latestAction.current = action;
  useEffect(() => {
    alive.current = true;
    const retire = () => {
      authEpoch.current++;
      epoch.current++;
      controller.current?.abort();
      linked.current = null;
      setAction(undefined);
    };
    window.addEventListener(AUTH_LOST_EVENT, retire);
    window.addEventListener(AUTH_RESTORED_EVENT, retire);
    return () => {
      alive.current = false;
      epoch.current++;
      controller.current?.abort();
      window.removeEventListener(AUTH_LOST_EVENT, retire);
      window.removeEventListener(AUTH_RESTORED_EVENT, retire);
    };
  }, []);
  const visible = action?.basis === basis ? action : undefined;
  const observed = source.sourceSetup;
  const explicit = visible?.selected;
  const selected =
    observed?.state === 'unavailable'
      ? undefined
      : observed?.state === 'selected' &&
          (!explicit || observed.collaboration.revision >= explicit.collaboration.revision)
        ? observed
        : explicit;
  const conflict =
    observed?.state === 'selected' &&
    explicit &&
    observed.collaboration.collaborationId !== explicit.collaboration.collaborationId;
  const group = !conflict ? selected?.collaboration.collaborationId : undefined;
  const actionEpoch = epoch.current;
  const loginEpoch = authEpoch.current;
  const ownerTag = useMemo(
    () => ({ basis, group, actionEpoch, authEpoch: loginEpoch }),
    [basis, group, actionEpoch, loginEpoch],
  );
  const currentTag = useRef(ownerTag);
  currentTag.current = ownerTag;
  const isCurrent = useCallback(
    () =>
      alive.current &&
      currentTag.current === ownerTag &&
      currentBasis.current === basis &&
      epoch.current === ownerTag.actionEpoch &&
      authEpoch.current === ownerTag.authEpoch &&
      currentVerifiedAuthSessionId() === basis.scope.login &&
      getApiBaseUrl() === basis.scope.base &&
      currentClient.current === basis.scope.clientId,
    [basis, ownerTag],
  );
  const getRepository = useCallback(() => {
    const current = latestCatalog.current;
    return isCurrent() && current.scope === basis.scope
      ? (current.catalog?.sourceRepository?.repository ?? null)
      : null;
  }, [basis, isCurrent]);
  const refreshSource = source.refresh;
  const refreshCatalog = catalog.refresh;
  const owner = useMemo(() => {
    if (
      !group ||
      !options.sourceConversationId ||
      !basis.scope.login ||
      visible?.pending ||
      conflict
    )
      return undefined;
    try {
      return createPreparedConversationJoiningOwner({
        api,
        sourceConversationId: options.sourceConversationId,
        collaborationId: group,
        getClientId: () => currentClient.current ?? undefined,
        getVerifiedAuthScope: currentVerifiedAuthSessionId,
        getRepository,
        isCurrent,
        onLinked: () => {
          linked.current = basis;
          refreshSource();
          refreshCatalog();
        },
      });
    } catch {
      return undefined;
    }
  }, [
    group,
    options.sourceConversationId,
    basis,
    visible?.pending,
    conflict,
    getRepository,
    isCurrent,
    refreshSource,
    refreshCatalog,
    catalog.catalog?.sourceRepository?.repository,
  ]);
  const add = useCallback(async () => {
    if (
      !options.sourceConversationId ||
      !currentVerifiedAuthSessionId() ||
      currentBasis.current !== basis
    )
      return;
    const sequence = ++epoch.current;
    const loginEpoch = authEpoch.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const active = () =>
      alive.current &&
      currentBasis.current === basis &&
      epoch.current === sequence &&
      authEpoch.current === loginEpoch &&
      !abort.signal.aborted;
    const pending = { basis, epoch: sequence, pending: true };
    latestAction.current = pending;
    setAction(pending);
    try {
      const result = await resolveConversationJoiningSource({
        api,
        sourceConversationId: options.sourceConversationId,
        getClientId: () => currentClient.current,
        signal: abort.signal,
        isCurrent: active,
      });
      if (!active()) return;
      setAction({
        basis,
        epoch: sequence,
        pending: false,
        ...(result.state === 'selected'
          ? { selected: result }
          : {
              error:
                'Fresh agent setup could not be verified here. The original request stays retained.',
            }),
      });
      refreshSource();
    } catch {
      if (active())
        setAction({
          basis,
          epoch: sequence,
          pending: false,
          error: 'Fresh agent setup could not be checked. Check the original request again.',
        });
    }
  }, [options.sourceConversationId, basis, refreshSource]);
  const retry = useCallback(() => {
    if (latestAction.current?.basis === basis) void add();
    else {
      refreshSource();
      refreshCatalog();
    }
  }, [basis, add, refreshSource, refreshCatalog]);
  const shared =
    linked.current === basis || (selected?.collaboration.participantSessionIds.length ?? 0) > 1;
  const sharedScope = JSON.stringify([
    options.routeKey,
    currentVerifiedAuthSessionId() ?? null,
    getApiBaseUrl(),
    authEpoch.current,
  ]);
  if (
    heldShared.current.key !== sharedScope ||
    (options.sourceConversationId !== null &&
      heldShared.current.sourceId !== options.sourceConversationId)
  )
    heldShared.current = { key: sharedScope, sourceId: options.sourceConversationId, value: false };
  if (shared) heldShared.current.value = true;
  // This gate is consulted at the effect boundary, not only rendered into the
  // controls. It reads the genuine reader's current attempt and rejects a
  // retired route/auth/client/action closure even after A-B-A or same-ID restore.
  const currentSourceSetup = source.currentSourceSetup;
  const canSendOrdinary = useCallback(() => {
    if (!isCurrent()) return false;
    if (heldShared.current.value) return false;
    if (!membershipRequired.current.value) return true;
    if (
      !ordinarySource ||
      ordinarySource !== basis.scope.sourceConversationId ||
      (latestAction.current?.basis === basis && latestAction.current.pending)
    )
      return false;
    const current = currentSourceSetup();
    return (
      current?.sourceConversationId === ordinarySource &&
      (current.state === 'unstarted' ||
        (current.state === 'selected' &&
          current.collaboration.participantSessionIds.length === 1 &&
          current.collaboration.participantSessionIds[0] === ordinarySource))
    );
  }, [isCurrent, ordinarySource, basis, currentSourceSetup]);
  const ordinaryAllowed = canSendOrdinary();
  return {
    // Read composition only. These are the existing canonical selection and
    // route/auth/client/action fence, never delivery or capacity authority.
    membership: conflict ? undefined : selected?.collaboration,
    authScope: basis.scope.login,
    isCurrent,
    owner,
    catalog,
    add,
    retry,
    reason: conflict
      ? 'The original shared conversation must be checked before continuing.'
      : visible?.pending
        ? 'Checking fresh-agent setup…'
        : (visible?.error ??
          source.reason ??
          (!catalog.catalog?.sourceRepository
            ? 'A verified source repository is required for a fresh agent. Your setup stays here.'
            : undefined)),
    canRetry: !visible?.pending && (!!visible?.error || source.canRefresh || !!catalog.reason),
    // Canonical membership/validated linked receipt can only refuse ordinary
    // fallback. They never enable group sending or establish admission.
    canSendOrdinary,
    sendUnavailable: ordinaryAllowed
      ? undefined
      : heldShared.current.value
        ? 'Shared discussion sending is unavailable. Your draft stays here.'
        : 'Verify this conversation’s membership before sending. Your draft stays here.',
  };
}
