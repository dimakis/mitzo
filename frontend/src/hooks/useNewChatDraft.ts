import { useCallback, useMemo, useState } from 'react';
import { createChatDraft, getChatDraft, saveChatDraft, type ChatDraft } from '../lib/chat-drafts';

/** A genuine New/reset owns a new identity; route/profile edits retain it. */
export function useNewChatDraft(requestedId: string | null, generation: number, enabled: boolean) {
  const owner = useMemo(() => {
    const saved = requestedId ? getChatDraft(requestedId) : null;
    return {
      draft: saved ?? createChatDraft(),
      restored: !!saved,
      missing: !!requestedId && !saved,
      generation,
    };
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
  return { ...owner, saveSettings, settingsError };
}
