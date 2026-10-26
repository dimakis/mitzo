import { createRoot } from 'react-dom/client';
import { createMitzoStore } from '@mitzo/client';
import { MitzoStoreProvider } from '@mitzo/client/hooks';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { LegacyNativeContinuation } from '../../frontend/src/components/LegacyNativeContinuation';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/motion.css';

const store = createMitzoStore({
  transport: { fetch, connectWs() {} },
  wsConfig: {
    buildUrl: () => '',
    createWebSocket: () => ({
      readyState: 0,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send() {},
      close() {},
    }),
  },
});
store.setState({
  connection: {
    ...store.getState().connection,
    clientId: 'fixture-connection',
    status: 'connected',
  },
});
const binding = {
  version: 2 as const,
  account: { accountId: 'work', provider: 'openai' as const, profileRevision: 'r1' },
  harness: { implementation: 'responses' as const },
  execution: { location: 'local' as const, targetId: 'mac', targetRevision: 'target-r1' },
};
function Fixture() {
  const location = useLocation();
  return (
    <main className="fixture-main">
      <h1>Historical conversation</h1>
      <label>
        Original conversation draft
        <textarea defaultValue="Keep this unsent draft in the original conversation." />
      </label>
      <LegacyNativeContinuation
        sourceSessionId="legacy-source"
        binding={new URLSearchParams(window.location.search).has('pre-runtime') ? null : binding}
        model="luna-fixture"
        thinking="low"
        mode="agent"
        beforeOpenNative={() => true}
      />
      <output aria-label="Current conversation">{location.pathname}</output>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <MitzoStoreProvider value={store}>
    <MemoryRouter initialEntries={['/chat/legacy-source']}>
      <Fixture />
    </MemoryRouter>
  </MitzoStoreProvider>,
);
