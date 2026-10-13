import { useSearchParams } from 'react-router-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createChatDraft, getChatDraft, saveChatDraft, type ChatDraft } from '../lib/chat-drafts';
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
    };
    previousOwner.current = next;
    return next;
  }, [requestedId, generation]);
  const [settingsError, setSettingsError] = useState(false);
  const saveSettings = useCallback(
    (settings: ChatDraft['settings']) => {
      if (!enabled || owner.missing) return;
      const saved = getChatDraft(owner.draft.id);
      if (!saved) return; // Untyped empty composers are not drafts.
      const selection = settings.selection ?? saved.settings.selection;
      const previousSearch = new URLSearchParams(saved.settings.search);
      const nextSearch = new URLSearchParams(settings.search);
      const profileChanged = ['agentProfile', 'profileRevision'].some(
        (key) => previousSearch.get(key) !== nextSearch.get(key),
      );
      const runtimeSelection = retainChatRuntimeSelection(
        settings.runtimeSelection === undefined
          ? saved.settings.runtimeSelection
          : settings.runtimeSelection,
        selection,
        profileChanged ? chatAgentProfileFromSearch(settings.search) : undefined,
      );
      const next = {
        ...settings,
        selection,
        summary: settings.summary ?? saved.settings.summary,
        ...(runtimeSelection !== undefined ? { runtimeSelection } : {}),
      };
      if (JSON.stringify(saved.settings) !== JSON.stringify(next))
        setSettingsError(!saveChatDraft({ ...saved, settings: next }));
    },
    [enabled, owner],
  );
  const releaseReference = useCallback(() => {
    releasedReference.current = owner.draft.id;
  }, [owner.draft.id]);
  return { ...owner, saveSettings, settingsError, releaseReference };
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
