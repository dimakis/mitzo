import { useSearchParams } from 'react-router-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSessionLaunchDefaults } from './useSessionLaunchDefaults';
import { sessionLaunchConfigurationDraft } from '../lib/session-launch-defaults';
import {
  createChatDraft,
  getChatDraft,
  saveChatDraft,
  ChatDraftSchema,
  type ChatDraft,
} from '../lib/chat-drafts';
import {
  chatAgentProfileFromSearch,
  retainChatRuntimeSelection,
} from '../lib/chat-runtime-selection';

/** A genuine New/reset owns a new identity; route/profile edits retain it. */
export function useNewChatDraft(requestedId: string | null, generation: number, enabled: boolean) {
  const previousOwner = useRef<{
    draft: ChatDraft;
    restored: boolean;
    missing: boolean;
    generation: number;
    urlOwned: boolean;
    edited: boolean;
    defaultsApplied: boolean;
  } | null>(null);
  const releasedReference = useRef<string | null>(null);
  const owner = useMemo(() => {
    if (
      previousOwner.current?.generation === generation &&
      (requestedId === previousOwner.current.draft.id ||
        (requestedId === null && releasedReference.current === previousOwner.current.draft.id))
    )
      return previousOwner.current;
    const saved = requestedId ? getChatDraft(requestedId) : null;
    const next = {
      draft: saved ?? createChatDraft(),
      restored: !!saved,
      missing: !!requestedId && !saved,
      generation,
      urlOwned: true,
      edited: false,
      defaultsApplied: false,
    };
    return next;
  }, [requestedId, generation]);
  // StrictMode may discard a memo calculation. Track the owner React retained,
  // rather than publishing a different owner from a discarded calculation.
  previousOwner.current = owner;
  const defaults = useSessionLaunchDefaults(enabled && !owner.missing, owner.draft.id);
  const [defaultsRevision, setDefaultsRevision] = useState(0);
  useEffect(() => {
    if (
      !enabled ||
      !defaults.configuration ||
      owner.restored ||
      owner.missing ||
      owner.edited ||
      owner.defaultsApplied
    )
      return;
    if (getChatDraft(owner.draft.id)) {
      owner.edited = true;
      setDefaultsRevision((value) => value + 1);
      return;
    }
    const seeded = sessionLaunchConfigurationDraft(defaults.configuration);
    owner.draft = { ...seeded, id: owner.draft.id };
    owner.defaultsApplied = true;
    setDefaultsRevision((value) => value + 1);
  }, [enabled, defaults.configuration, owner]);
  const markEdited = useCallback(() => {
    owner.edited = true;
  }, [owner]);
  const [settingsError, setSettingsError] = useState(false);
  const [, setContextRevision] = useState(0);
  const removeContextBlock = useCallback(
    (name: string) => {
      if (!enabled || owner.missing || previousOwner.current !== owner || !owner.urlOwned) return;
      const saved = getChatDraft(owner.draft.id);
      const contextBlocks = (saved ?? owner.draft).contextBlocks.filter((value) => value !== name);
      owner.edited = true;
      owner.draft = { ...owner.draft, contextBlocks };
      if (saved) setSettingsError(!saveChatDraft({ ...saved, contextBlocks }));
      setContextRevision((value) => value + 1);
    },
    [enabled, owner],
  );
  const saveSettings = useCallback(
    (settings: ChatDraft['settings']) => {
      if (!enabled || owner.missing) return;
      const saved = getChatDraft(owner.draft.id);
      if (!saved) return; // Untyped empty composers are not drafts.
      const selection = settings.runtimeSelection
        ? settings.runtimeSelection.account
        : (settings.selection ?? saved.settings.selection);
      const previousSearch = new URLSearchParams(saved.settings.search);
      const nextSearch = new URLSearchParams(settings.search);
      const profileChanged = ['agentProfile', 'profileRevision', 'agentProfileKind'].some(
        (key) => previousSearch.get(key) !== nextSearch.get(key),
      );
      const runtimeSelection = retainChatRuntimeSelection(
        settings.runtimeSelection === undefined
          ? saved.settings.runtimeSelection
          : settings.runtimeSelection,
        selection,
        profileChanged ? chatAgentProfileFromSearch(settings.search) : undefined,
      );
      // Compare the same stored schema shape: property-order-only differences
      // must not publish another draft event and refresh a launch indefinitely.
      const next = ChatDraftSchema.shape.settings.parse({
        ...settings,
        sourceSnapshots: saved.settings.sourceSnapshots,
        selection,
        summary: settings.summary ?? saved.settings.summary,
        ...(runtimeSelection !== undefined ? { runtimeSelection } : {}),
      });
      if (JSON.stringify(saved.settings) !== JSON.stringify(next))
        setSettingsError(!saveChatDraft({ ...saved, settings: next }));
    },
    [enabled, owner],
  );
  const releaseReference = useCallback(() => {
    releasedReference.current = owner.draft.id;
  }, [owner.draft.id]);
  // History changes before React commits a route transition. Retained listeners
  // must lose this owner's URL authority at successful handoff, rather than
  // waiting for their passive cleanup. A genuine New/reset gets a new owner.
  const ownsUrl = useCallback(() => previousOwner.current === owner && owner.urlOwned, [owner]);
  const releaseUrlOwnership = useCallback(() => {
    owner.urlOwned = false;
  }, [owner]);
  return {
    ...owner,
    defaultsHydrating:
      enabled &&
      !owner.restored &&
      !owner.missing &&
      !owner.edited &&
      (defaults.loading || (!!defaults.configuration && !owner.defaultsApplied)),
    defaults,
    defaultsRevision,
    markEdited,
    removeContextBlock,
    saveSettings,
    settingsError,
    releaseReference,
    ownsUrl,
    releaseUrlOwnership,
  };
}

/** Restore the launch context once; later explicit query edits remain authoritative. */
export function useChatDraftSearch(enabled: boolean) {
  const [routeSearch, setRouteSearch] = useSearchParams();
  const requestedId = enabled ? routeSearch.get('draft') : null;
  const scope = useMemo(() => {
    const saved = requestedId ? getChatDraft(requestedId) : null;
    const params = new URLSearchParams(saved?.settings.search);
    routeSearch.forEach((value, key) => params.set(key, value));
    return { params, initialSearch: routeSearch.toString() };
  }, [requestedId]); // eslint-disable-line react-hooks/exhaustive-deps
  const requestedScope = useRef<typeof scope | null>(null);
  const hydratedScope = useRef<typeof scope | null>(null);
  // Browser history updates before React Router commits its location transition.
  // Keep restored context effective across intervening renders; only an observed
  // location update completes hydration. Later explicit query edits stay authoritative.
  const acknowledged =
    hydratedScope.current === scope ||
    routeSearch.toString() !== scope.initialSearch ||
    scope.params.toString() === scope.initialSearch;
  const search = acknowledged ? routeSearch : scope.params;
  useEffect(() => {
    if (acknowledged) {
      hydratedScope.current = scope;
      return;
    }
    if (requestedScope.current === scope) return;
    requestedScope.current = scope;
    setRouteSearch(scope.params, { replace: true });
  }, [acknowledged, scope, setRouteSearch]);
  return search;
}
