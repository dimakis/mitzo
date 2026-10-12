import { useSearchParams } from 'react-router-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createChatDraft, getChatDraft, saveChatDraft, type ChatDraft } from '../lib/chat-drafts';

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
      const next = {
        ...settings,
        selection: settings.selection ?? saved.settings.selection,
        summary: settings.summary ?? saved.settings.summary,
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
    return { params };
  }, [requestedId]); // eslint-disable-line react-hooks/exhaustive-deps
  const hydratedScope = useRef<typeof scope | null>(null);
  const search = hydratedScope.current === scope ? routeSearch : scope.params;
  useEffect(() => {
    if (hydratedScope.current === scope) return;
    hydratedScope.current = scope;
    if (scope.params.toString() !== routeSearch.toString())
      setRouteSearch(scope.params, { replace: true });
  }, [scope, routeSearch, setRouteSearch]);
  return search;
}
