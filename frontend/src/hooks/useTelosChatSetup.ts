import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useMitzoStore } from '@mitzo/client/hooks';
import { createChatDraft, saveChatDraft } from '../lib/chat-drafts';

/** The ordinary role-entry owner shared by Overview and the Chat chooser. */
export function useTelosChatSetup(itemId: string) {
  const navigate = useNavigate(),
    location = useLocation();
  const newSession = useMitzoStore((s) => s.newSession);
  const [error, setError] = useState('');
  function configure(
    role: 'lead' | 'worker' | 'advisor',
    mode: 'assign' | 'additional',
    purpose?: 'refine' | 'child',
  ) {
    setError('');
    const draft = createChatDraft();
    const params = new URLSearchParams({
      telosRoleItem: itemId,
      telosRole: role,
      telosRoleMode: mode,
    });
    if (purpose) params.set('telosAdvisor', purpose);
    draft.settings = { ...draft.settings, search: params.toString(), retainRuntimeIntent: true };
    if (!saveChatDraft(draft)) {
      setError('Chat setup could not be saved on this device.');
      return;
    }
    params.set('draft', draft.id);
    newSession();
    navigate(`/chat?${params}`, { state: location.state });
  }
  return { configure, error };
}
