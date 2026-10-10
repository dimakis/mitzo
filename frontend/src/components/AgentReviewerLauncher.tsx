import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AgentProfileSelection } from '@mitzo/protocol';
import { apiFetch } from '../lib/api-fetch';

export function AgentReviewerLauncher({ selection }: { selection: AgentProfileSelection }) {
  const [sessions, setSessions] = useState<{ id: string; summary?: string }[] | null>(null);
  const [chosen, setChosen] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch('/api/sessions?limit=30');
      const body = await response.json();
      if (!response.ok || !Array.isArray(body.sessions))
        throw Error(body?.error || 'Conversations unavailable');
      setSessions(
        body.sessions.filter((session: { id?: unknown }) => typeof session.id === 'string'),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Conversations unavailable');
    } finally {
      setBusy(false);
    }
  };
  const params = new URLSearchParams({
    reviewerProfile: selection.profileId,
    reviewerRevision: String(selection.revision),
  });
  return (
    <div className="agent-library-reviewer-launcher">
      <button disabled={busy} onClick={() => void load()}>
        Use as reviewer
      </button>
      {sessions && (
        <>
          <label>
            Conversation
            <select value={chosen} onChange={(e) => setChosen(e.target.value)}>
              <option value="">Choose an existing chat</option>
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.summary || session.id}
                </option>
              ))}
            </select>
          </label>
          {sessions.length === 0 && <p>Create a chat before adding a reviewer.</p>}
          {chosen && (
            <Link to={`/chat/${encodeURIComponent(chosen)}?${params}`}>Set up reviewer</Link>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
