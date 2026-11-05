import { useEffect, useState } from 'react';
import { CHAT_DRAFTS_CHANGED, listChatDrafts, migrateLegacyChatDraft } from '../lib/chat-drafts';
import { COMPOSER_DRAFT_ACCEPTED } from '../lib/composer-draft-proof';
export function useSavedChatDrafts() {
  const [drafts, setDrafts] = useState(() => {
    migrateLegacyChatDraft();
    return listChatDrafts();
  });
  useEffect(() => {
    const refresh = () => setDrafts(listChatDrafts());
    window.addEventListener(CHAT_DRAFTS_CHANGED, refresh);
    window.addEventListener(COMPOSER_DRAFT_ACCEPTED, refresh);
    window.addEventListener('storage', refresh);
    refresh();
    return () => {
      window.removeEventListener(CHAT_DRAFTS_CHANGED, refresh);
      window.removeEventListener(COMPOSER_DRAFT_ACCEPTED, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  return drafts;
}
