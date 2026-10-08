import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from '../lib/api-fetch';

const Candidates = z.object({
  candidates: z.array(
    z.object({
      id: z.string().min(1),
      summary: z.string(),
      cwd: z.string().optional(),
      lastModified: z.number(),
    }),
  ),
});
type Candidate = z.infer<typeof Candidates>['candidates'][number];

export function SdkConversationImport({
  onImported,
  onClose,
}: {
  onImported(id: string): void;
  onClose(): void;
}) {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const lifetime = useRef<AbortController | null>(null);
  const importing = useRef(false);
  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort;
    heading.current?.focus();
    void apiFetch('/api/sessions/importable', { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const data = Candidates.parse(await response.json());
        if (!abort.signal.aborted) setCandidates(data.candidates);
      })
      .catch(() => {
        if (!abort.signal.aborted)
          setError('Could not find external conversations. Close and try again.');
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => {
      abort.abort();
    };
  }, []);
  function close() {
    lifetime.current?.abort();
    onClose();
  }
  async function importConversation(id: string) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || importing.current) return;
    importing.current = true;
    setPending(true);
    setError('');
    try {
      const response = await apiFetch('/api/sessions/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: id }),
        signal,
      });
      if (!response.ok) throw new Error();
      const result = z.object({ sessionId: z.literal(id) }).parse(await response.json());
      if (!signal.aborted) onImported(result.sessionId);
    } catch {
      if (!signal.aborted) setError('Could not import this conversation. Try again.');
    } finally {
      importing.current = false;
      if (!signal.aborted) setPending(false);
    }
  }
  return (
    <section
      aria-label="Import external conversations"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          close();
        }
      }}
    >
      <h2 ref={heading} tabIndex={-1}>
        Import a conversation
      </h2>
      <p>Select a CLI conversation to add to Chats.</p>
      <button onClick={close}>Close import</button>
      {loading && <p role="status">Finding conversations…</p>}
      {pending && <p role="status">Importing conversation…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && !candidates.length && (
        <p>No external conversations available to import.</p>
      )}
      {candidates.map((candidate) => (
        <div className="session-item" key={candidate.id}>
          <div className="session-item-content">
            <div className="session-item-summary">
              {candidate.summary || 'Untitled conversation'}
            </div>
            {candidate.cwd && (
              <p className="conversation-repo">{candidate.cwd.split('/').filter(Boolean).pop()}</p>
            )}
          </div>
          <button
            disabled={pending}
            aria-label={`Import ${candidate.summary || 'Untitled conversation'}`}
            onClick={() => void importConversation(candidate.id)}
          >
            Import
          </button>
        </div>
      ))}
    </section>
  );
}
