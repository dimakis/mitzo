import { useNavigate } from 'react-router-dom';
import { useMitzoStore } from '@mitzo/client/hooks';
import type { PendingSession } from '@mitzo/client';
import { createChatDraft, saveChatDraft, chatDraftUrl } from '../lib/chat-drafts';

/** Save before navigation, including launches whose composer has never been typed in. */
export function useStageChatLaunch() {
  const navigate = useNavigate();
  const stage = useMitzoStore((s) => s.setPendingSession);
  return (launch: PendingSession, search = '') => {
    const draft = createChatDraft();
    draft.text = launch.prompt;
    draft.contextBlocks = launch.contextBlocks ?? [];
    draft.settings = {
      ...draft.settings,
      launch,
      selection: launch.accountSelection ?? null,
      search,
    };
    if (!saveChatDraft(draft)) throw new Error('Could not save this launch draft. Try again.');
    stage({ ...launch, draftId: draft.id });
    navigate(chatDraftUrl(draft));
  };
}
