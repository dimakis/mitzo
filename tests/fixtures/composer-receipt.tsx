import { chatStorage } from '../../frontend/src/lib/large-chat-storage';
import { createRoot } from 'react-dom/client';
import { createMitzoStore } from '@mitzo/client';
import {
  OrdinaryRuntimeContinuationCommandSchema,
  OrdinaryWorkspaceContinuationCommandSchema,
} from '@mitzo/protocol';
import { MitzoStoreProvider, useMitzoStore } from '@mitzo/client/hooks';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import { ChatStatusMessage } from '../../frontend/src/components/ChatStatusMessage';
import { useLocalCommandRecovery } from '../../frontend/src/components/LocalCommandRecovery';
import { ComposerStatusProvider } from '../../frontend/src/components/ComposerStatus';
import { createReviewedOutboxStorage } from '../../frontend/src/lib/reviewed-outbox-storage';
import { createBrowserId } from '../../frontend/src/lib/browser-crypto';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/desktop.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';
import './queue-status.css';

// The real store, outbox and composer share only intercepted synthetic traffic.
let welcome!: () => void;
const connected = new Promise<void>((resolve) => {
  welcome = resolve;
});
const store = createMitzoStore({
  transport: { fetch: (url, options) => fetch(url, options) },
  wsConfig: {
    buildUrl: () => '/offline',
    createWebSocket: () => {
      throw Error('Unexpected WebSocket');
    },
  },
  sseConfig: {
    baseUrl: '',
    fetch: (url, options) => fetch(url, options),
    createEventSource: () => {
      const source = new EventTarget() as EventSource;
      Object.assign(source, { readyState: 1, close() {} });
      setTimeout(() => {
        source.dispatchEvent(
          new MessageEvent('welcome', {
            data: JSON.stringify({ connectionId: 'signed-offline-sse' }),
          }),
        );
        welcome();
      }, 0);
      return source;
    },
  },
  localFirstCommandConfig: {
    url: '/api/chat/local-codex/send',
    storage: createReviewedOutboxStorage(
      chatStorage,
      location.origin + '/api/chat/local-codex/send',
      'local',
    ),
  },
});
await connected;
await store.getState().switchSession('cold-chat');
store.getState().selectLocalCommandSession('cold-chat');
function ComposerReceiptFixture() {
  const claude = new URLSearchParams(location.search).has('claude');
  const command = useMitzoStore((state) => state.localCommand);
  const send = useMitzoStore((state) => state.sendOrdinaryWorkspaceCommand);
  const sendLocal = useMitzoStore((state) => state.sendLocalFirstCommand);
  const error = useMitzoStore((state) => state.sendError);
  const recover = useMitzoStore((state) => state.recoverLocalCommand);
  const withdraw = useMitzoStore((state) => state.withdrawLocalCommand);
  const recovery = useLocalCommandRecovery({
    command,
    connected: true,
    recover,
    withdraw,
    refresh: () => {},
    scope: 'cold-chat',
  });
  const commandState = useMitzoStore((state) =>
    command?.request ? state.messages.commandStates?.[command.request.clientMsgId] : undefined,
  );
  return (
    <ComposerStatusProvider>
      <main className="queue-status-fixture">
        {recovery.dialog}
        <p data-testid="receipt-state">{command?.state ?? 'idle'}</p>
        <p data-testid="command-state">{commandState ?? 'idle'}</p>
        {!new URLSearchParams(location.search).has('hide') && (
          <div className="queue-status-composer">
            <ChatStatusMessage error={error} />
            <ChatInput
              sessionId="cold-chat"
              running={false}
              guardedConversation
              sendDisabledReason={
                command && command.state !== 'consumed'
                  ? command.state === 'pending'
                    ? 'Sending…'
                    : 'Delivery not confirmed.'
                  : undefined
              }
              sendDisabledAction={
                command && !['pending', 'consumed'].includes(command.state)
                  ? recovery.action
                  : undefined
              }
              onStop={() => {}}
              acceptedComposerDraft={
                command?.state === 'consumed' ? command.composerDraft : undefined
              }
              onSend={(text, _images, _context, onDelivery, _onAssigned, composerDraft) => {
                const command = {
                  runOn: 'local',
                  sessionId: 'cold-chat',
                  clientMsgId: createBrowserId(),
                  capabilityRevision: 'caps',
                  runtime: {
                    account: {
                      accountId: 'work',
                      provider: claude ? 'anthropic-claude' : 'openai-codex',
                      profileRevision: 'r1',
                    },
                    harness: claude ? 'claude-sdk' : 'codex',
                    targetId: 'mac',
                    mode: 'agent',
                  },
                  selection: {
                    version: 1,
                    agent: { profileId: 'agent', revision: 1 },
                    model: 'luna-fixture',
                    thinking: 'low',
                    context: { source: 'none', revision: null },
                    permission: { mode: 'agent', revision: 0 },
                  },
                  payload: { text },
                };
                return claude
                  ? sendLocal(
                      OrdinaryRuntimeContinuationCommandSchema.parse({
                        ...command,
                        repositoryWorkspaceId: '11111111-1111-4111-8111-111111111111',
                      }),
                      { onDelivery, composerDraft },
                    )
                  : send(
                      OrdinaryWorkspaceContinuationCommandSchema.parse({
                        ...command,
                        version: 2,
                        workspace: {
                          kind: 'ordinary',
                          workspaceId: '11111111-1111-4111-8111-111111111111',
                        },
                      }),
                      'continue',
                      { onDelivery, composerDraft },
                    );
              }}
            />
          </div>
        )}
      </main>
    </ComposerStatusProvider>
  );
}
createRoot(document.getElementById('root')!).render(
  <MitzoStoreProvider value={store}>
    <ComposerReceiptFixture />
  </MitzoStoreProvider>,
);
