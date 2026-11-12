import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { MitzoMode } from '@mitzo/protocol';
import { WorkspaceControls } from '../../frontend/src/components/WorkspaceControls';
import { PermissionModePicker } from '../../frontend/src/components/PermissionModePicker';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/workspace.css';
import '../../frontend/src/styles/workspace-chat.css';

function Fixture() {
  const fresh = new URLSearchParams(location.search).has('new');
  const endpoint = `/mode/${fresh ? 'draft' : 'chat'}`;
  const [mode, setMode] = useState<MitzoMode>('agent');
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    void fetch(endpoint)
      .then(async (response) => {
        if (!response.ok) throw Error('Permission settings are unavailable.');
        const saved = await response.json();
        if (current) setMode(saved.mode);
      })
      .catch((cause) => {
        console.warn('[mitzo] Fixture mode read failed', {
          code: 'fixture_mode_read_failed',
          cause,
        });
        if (current) setError('Permission settings are unavailable.');
      })
      .finally(() => {
        if (current) setPending(false);
      });
    return () => {
      current = false;
    };
  }, [endpoint]);
  async function change(next: MitzoMode) {
    setPending(true);
    setError('');
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: next }),
      });
      const saved = await response.json();
      if (!response.ok) throw Error(saved.error);
      setMode(saved.mode);
    } catch (cause) {
      console.warn('[mitzo] Fixture mode update failed', {
        code: 'fixture_mode_update_failed',
        cause,
      });
      setError('The mode was not changed. Try again.');
    } finally {
      setPending(false);
    }
  }
  return (
    <main className="chat-page workspace-chat">
      <WorkspaceControls
        title={fresh ? 'New chat' : 'Existing chat'}
        agent="Mitzo"
        status="Ready"
        scopeKey={fresh ? 'draft' : 'chat'}
        settings={<span />}
      >
        <header className="chat-header">
          <PermissionModePicker
            mode={mode}
            disabled={pending}
            onChange={(next) => void change(next)}
          />
        </header>
      </WorkspaceControls>
      {error && (
        <p className="workspace-muted" role="alert">
          {error}
        </p>
      )}
      <p className="workspace-muted" role="status">
        {pending ? 'Saving mode…' : `Saved mode: ${mode}`}
      </p>
      <label>
        Message draft
        <textarea aria-label="Message draft" defaultValue="Keep my draft" />
      </label>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
