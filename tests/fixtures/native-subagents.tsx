import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { createMitzoStore } from '@mitzo/client';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { ChatArea } from '../../frontend/src/components/ChatArea';
import { ChatInput } from '../../frontend/src/components/ChatInput';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace-chat.css';
import './native-subagents.css';

const store = createMitzoStore({
  transport: { fetch: (url, options) => fetch(url, options) },
  wsConfig: {
    buildUrl: () => '/offline',
    createWebSocket: () => ({
      readyState: 1,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send() {},
      close() {},
    }),
  },
});
function Fixture() {
  const [replied, setReplied] = useState(false);
  useEffect(() => {
    Object.assign(window, { completeFixtureParent: () => setReplied(true) });
  }, []);
  return (
    <MemoryRouter>
      <MitzoStoreProvider value={store}>
        <main className="native-subagents-fixture">
          <header>
            <h1>Inbox search</h1>
          </header>
          <section className="native-subagents-fixture-thread">
            <p>I’m checking the implementation while two subagents review tests and edge cases.</p>
            <ChatArea
              sessionId="native-fixture"
              current={null}
              running={!replied}
              permission={null}
              onPermissionRespond={() => {}}
              messages={[
                {
                  messageId: 'parent',
                  role: 'assistant',
                  blocks: [
                    {
                      blockId: 'read',
                      blockType: 'tool_use',
                      content: '',
                      toolName: 'Read',
                      toolResult: 'Source inspected',
                    },
                    {
                      blockId: 'children',
                      blockType: 'tool_use',
                      content: '',
                      toolName: 'Agent',
                    rawInput: { type: 'agent', nativeSubagentCommandId: 'command' },
                      toolResult: 'Admitted',
                    },
                    ...(replied
                      ? [
                          {
                            blockId: 'reply',
                            blockType: 'text' as const,
                            content: 'Parent finished its review.',
                          },
                        ]
                      : []),
                  ],
                },
              ]}
            />
          </section>
          <ChatInput
            sessionId="native-fixture"
            running={false}
            onSend={() => false}
            onStop={() => {}}
            tokenState={{
              agentContext: 5000,
              contextCeiling: 200000,
              sessionTotal: 9000,
              numTurns: 2,
              turnIndex: 1,
              numCompactions: 0,
            }}
          />
        </main>
      </MitzoStoreProvider>
    </MemoryRouter>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
