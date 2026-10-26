import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { createMitzoStore } from '@mitzo/client';
import { MitzoStoreProvider, useMitzoStore } from '@mitzo/client/hooks';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import { ChatStatusMessage } from '../../frontend/src/components/ChatStatusMessage';
import { SymposiumConversation } from '../../frontend/src/components/SymposiumConversation';
import { createReviewedOutboxStorage } from '../../frontend/src/lib/reviewed-outbox-storage';
import { createBrowserId } from '../../frontend/src/lib/browser-crypto';
import {
  createChatDraft,
  saveChatDraft,
  chatDraftStorageKey,
} from '../../frontend/src/lib/chat-drafts';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/desktop.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';
import './queue-status.css';
const draft = createChatDraft();
draft.text = 'Inspect the attached screenshot and preserve my request.';
draft.images = [
  {
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    mediaType: 'image/png',
    preview:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  },
];
saveChatDraft(draft);
let blockStorage = true;
const disk = createReviewedOutboxStorage(
  localStorage,
  location.origin + '/api/chat/local-codex/send',
  'local',
);
let welcome!: () => void;
const connected = new Promise<void>((resolve) => {
  welcome = resolve;
});
const store = createMitzoStore({
  transport: { fetch: (url, init) => fetch(url, init) },
  wsConfig: {
    buildUrl: () => '',
    createWebSocket: () => {
      throw Error('Unexpected WebSocket');
    },
  },
  sseConfig: {
    baseUrl: '',
    fetch: (url, init) => fetch(url, init),
    createEventSource: () => {
      const source = new EventTarget() as EventSource;
      Object.assign(source, { readyState: 1, close() {} });
      setTimeout(() => {
        source.dispatchEvent(
          new MessageEvent('welcome', {
            data: JSON.stringify({ connectionId: 'offline-feedback' }),
          }),
        );
        welcome();
      }, 0);
      return source;
    },
  },
  localFirstCommandConfig: {
    url: '/api/chat/local-codex/send',
    storage: {
      getItem: disk.getItem,
      setItem: (name, value) => {
        if (blockStorage) throw Error('Synthetic storage quota');
        disk.setItem(name, value);
      },
    },
  },
});
await connected;
store.getState().selectLocalCommandDraft(draft.id);
function Fixture() {
  const error = useMitzoStore((s) => s.sendError);
  const status = useMitzoStore((s) => s.sendStatus);
  return (
    <main className="queue-status-fixture">
      <button
        onClick={() => {
          blockStorage = false;
        }}
      >
        Restore fixture storage
      </button>
      <div className="queue-status-composer">
        <SymposiumConversation
          sessionId={null}
          profileToolsTarget={null}
          chat={{
            messages: [],
            current: null,
            running: false,
            permission: null,
            onPermissionRespond: () => {},
          }}
          pendingFeedback={<ChatStatusMessage error={error} status={status} />}
          ordinaryComposer={
            <ChatInput
              savedChatDraft={draft}
              draftStorageKey={chatDraftStorageKey(draft.id)}
              running={false}
              boundedFirstCommand
              sendLabel="Start session"
              onStop={() => {}}
              onSend={(text, images, _context, onDelivery) =>
                store
                  .getState()
                  .sendLocalFirstCommand(
                    {
                      runOn: 'local',
                      clientMsgId: createBrowserId(),
                      capabilityRevision: 'offline',
                      runtime: {
                        account: {
                          accountId: 'personal',
                          provider: 'openai-codex',
                          profileRevision: 'offline',
                        },
                        harness: 'codex',
                        targetId: 'mac',
                        mode: 'agent',
                      },
                      selection: {
                        version: 1,
                        agent: { kind: 'builtin', profileId: 'default-mitzo', revision: 1 },
                        model: 'luna-fixture',
                        thinking: 'high',
                        context: { source: 'none', revision: null },
                        permission: { mode: 'agent', revision: 0 },
                      },
                      payload: {
                        text,
                        images: images?.map(({ data, mediaType }) => ({ data, mediaType })),
                      },
                    },
                    { draftId: draft.id, onDelivery },
                  )
              }
            />
          }
        />
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <MitzoStoreProvider value={store}>
      <Fixture />
    </MitzoStoreProvider>
  </MemoryRouter>,
);
