import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  RepositoryChatPicker,
  type RepositoryChatSelection,
} from '../../frontend/src/components/RepositoryChatPicker';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
function Fixture() {
  const [location, setLocation] = useState<'local' | 'openshell'>('openshell');
  const [selection, setSelection] = useState<RepositoryChatSelection | null>(null);
  return (
    <main>
      <h1>Repository preparation fixture</h1>
      <button onClick={() => setLocation(location === 'local' ? 'openshell' : 'local')}>
        Switch execution
      </button>
      <p>Run on: {location}</p>
      <RepositoryChatPicker
        accountId="account"
        model="model"
        draftScoped
        ordinaryRuntime={{
          runOn: location,
          runtime: {
            account: { accountId: 'account', provider: 'openai', profileRevision: 'r1' },
            harness: location === 'local' ? 'responses' : 'codex',
            targetId: location === 'local' ? 'mac' : 'shell',
          },
        }}
        onChange={setSelection}
      />
      <label>
        Unsent draft
        <textarea defaultValue="Keep this development request" />
      </label>
      <button disabled={selection?.blocked !== false}>Send fixture</button>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
