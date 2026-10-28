import { useDraft } from '../../frontend/src/hooks/useDraft';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { DraftsView } from '../../frontend/src/pages/DraftsView';
import { chatStorage, initializeChatStorage } from '../../frontend/src/lib/large-chat-storage';
import { createChatDraft, saveChatDraft } from '../../frontend/src/lib/chat-drafts';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace.css';

function PlainDraft() {
  const [text, setText] = useDraft('plain-cold-reload');
  return (
    <textarea
      aria-label="Plain draft"
      value={text}
      onChange={(event) => setText(event.target.value)}
    />
  );
}

void initializeChatStorage().then(async () => {
  if (location.pathname === '/text') {
    createRoot(document.getElementById('root')!).render(<PlainDraft />);
    return;
  }
  if (!chatStorage.getItem('discard-fixture-seeded')) {
    const draft = { ...createChatDraft(), id: 'commit-discard', text: 'Discard only after commit' };
    saveChatDraft(draft);
    chatStorage.setItem('discard-fixture-seeded', 'true');
    await chatStorage.flush();
  }
  createRoot(document.getElementById('root')!).render(
    <MemoryRouter>
      <DraftsView />
    </MemoryRouter>,
  );
});
