import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { createMitzoStore } from '@mitzo/client';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { NativeSubagents } from '../../frontend/src/components/NativeSubagents';
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
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <MitzoStoreProvider value={store}>
      <main className="native-subagents-fixture">
        <header>
          <h1>Inbox search</h1>
        </header>
        <section className="native-subagents-fixture-thread">
          <p>I’m checking the implementation while two subagents review tests and edge cases.</p>
          <NativeSubagents sessionId="native-fixture" commandId="command" />
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
  </MemoryRouter>,
);
