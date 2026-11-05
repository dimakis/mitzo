import { useDraft } from '../../frontend/src/hooks/useDraft';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { DraftsView } from '../../frontend/src/pages/DraftsView';
import { chatStorage, initializeChatStorage } from '../../frontend/src/lib/large-chat-storage';
import {
  chatDraftStorageKey,
  createChatDraft,
  getChatDraft,
  saveChatDraft,
} from '../../frontend/src/lib/chat-drafts';
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

const sentDraftId = 'sent-fixture';
function SubmittedComposer({ onSubmit }: { onSubmit(accept: () => void): void }) {
  const [text, setText, , , receipt] = useDraft(
    undefined,
    undefined,
    chatDraftStorageKey(sentDraftId),
  );
  return (
    <>
      <textarea
        aria-label="Message"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button
        type="button"
        onClick={() => {
          const proof = receipt.capture()!;
          chatStorage.setItem('sent-fixture-submitted', 'true');
          onSubmit(() => {
            receipt.recordAcceptance(proof);
          });
        }}
      >
        Submit fixture message
      </button>
    </>
  );
}
function SentDraft() {
  const [composer, setComposer] = useState(!chatStorage.getItem('sent-fixture-submitted'));
  const [accept, setAccept] = useState<(() => void) | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  return (
    <MemoryRouter>
      {composer && (
        <SubmittedComposer
          onSubmit={(confirm) => {
            setAccept(() => confirm);
            setComposer(false);
          }}
        />
      )}
      {accept && (
        <>
          <button
            type="button"
            onClick={async () => {
              accept();
              await chatStorage.flush();
              setConfirmed(true);
            }}
          >
            Confirm fixture delivery
          </button>
          <button
            type="button"
            onClick={() => {
              saveChatDraft({ ...getChatDraft(sentDraftId)!, text: 'New unsent thought' });
            }}
          >
            Save another thought
          </button>
        </>
      )}
      {confirmed && <p role="status">Delivery confirmed</p>}
      <DraftsView />
    </MemoryRouter>
  );
}

void initializeChatStorage().then(async () => {
  if (location.pathname === '/sent') {
    if (!chatStorage.getItem('sent-fixture-seeded')) {
      saveChatDraft({
        ...createChatDraft(),
        id: sentDraftId,
        text: 'Screenshot already submitted',
        images: [{ data: 'abc', preview: 'data:image/png;base64,abc', mediaType: 'image/png' }],
      });
      chatStorage.setItem('sent-fixture-seeded', 'true');
      await chatStorage.flush();
    }
    createRoot(document.getElementById('root')!).render(<SentDraft />);
    return;
  }
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
