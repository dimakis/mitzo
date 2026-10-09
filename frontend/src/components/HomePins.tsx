import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { HomePin } from '@mitzo/protocol';
import type { Session } from '../types/chat';
import type { TodoItem } from '../types/todo';
import { useHomePreferences } from '../hooks/useHomePreferences';
import { useTodoData } from '../hooks/useTodoData';
import { useSessionSearch } from '../hooks/useSessionSearch';
import { recordTitle } from '../lib/record-title';
import { HomeDialog } from './HomeDialog';
import '../styles/home.css';

export function HomePins({ sessions }: { sessions: Session[] }) {
  const home = useHomePreferences();
  const [mode, setMode] = useState<'add' | 'manage' | null>(null);
  return (
    <section className="today-section" aria-labelledby="today-pins-title">
      <div className="workspace-section-heading home-section-heading">
        <h2 id="today-pins-title">Pinned to Today</h2>
        <div className="home-inline-actions">
          <button
            className="home-text-action"
            type="button"
            disabled={home.loading || !home.preferences}
            onClick={() => setMode('add')}
          >
            Add pin
          </button>
          <button
            className="home-text-action"
            type="button"
            disabled={home.loading || !home.preferences}
            onClick={() => setMode('manage')}
          >
            Manage pins
          </button>
        </div>
      </div>
      {home.loading ? (
        <p role="status">Loading pins…</p>
      ) : home.preferences?.pins.length ? (
        home.preferences.pins.map((pin) => (
          <Link
            className="workspace-record home-record"
            key={`${pin.kind}:${pin.id}`}
            to={
              pin.kind === 'session'
                ? `/chat/${encodeURIComponent(pin.id)}`
                : `/todos/${encodeURIComponent(pin.id)}`
            }
          >
            <span>
              <strong>{recordTitle(pin.title)}</strong>
              <small>{pin.kind === 'session' ? 'Session' : 'Work'} · Pinned to Today</small>
            </span>
            <span aria-hidden="true">↗</span>
          </Link>
        ))
      ) : (
        !home.error && (
          <p className="workspace-muted">
            Keep the sessions and work you want close. Pin them here or from their actions.
          </p>
        )
      )}
      {home.error && <p role="alert">{home.error}</p>}
      {mode && home.preferences && (
        <PinEditor
          mode={mode}
          initialPins={home.preferences.pins}
          sessions={sessions}
          home={home}
          onClose={() => setMode(null)}
        />
      )}
    </section>
  );
}
function flatten(items: TodoItem[]): TodoItem[] {
  return items.flatMap((item) => [item, ...flatten(item.children)]);
}
function PinEditor({
  mode,
  initialPins,
  sessions,
  home,
  onClose,
}: {
  mode: 'add' | 'manage';
  initialPins: HomePin[];
  sessions: Session[];
  home: ReturnType<typeof useHomePreferences>;
  onClose: () => void;
}) {
  const [pins, setPins] = useState(initialPins);
  const todos = useTodoData();
  const search = useSessionSearch();
  const [kind, setKind] = useState<'session' | 'telos'>('session');
  const [workQuery, setWorkQuery] = useState('');
  const candidates: HomePin[] =
    kind === 'session'
      ? (search.active
          ? search.results.map((result) => ({ id: result.sessionId, title: result.summary }))
          : sessions.map((session) => ({
              id: session.id,
              title: session.summary || 'Untitled session',
            }))
        ).map((item) => ({ ...item, kind, title: recordTitle(item.title) }))
      : flatten(todos.items)
          .filter((item) => item.summary.toLowerCase().includes(workQuery.toLowerCase()))
          .map((item) => ({ kind, id: item.id, title: recordTitle(item.summary) }));
  const available = candidates.filter(
    (item) => !pins.some((pin) => pin.kind === item.kind && pin.id === item.id),
  );
  function move(index: number, offset: number) {
    setPins((current) => {
      const next = [...current];
      [next[index], next[index + offset]] = [next[index + offset], next[index]];
      return next;
    });
  }
  async function save(next: HomePin[]) {
    if (await home.update({ pins: next })) onClose();
  }
  return (
    <HomeDialog title={mode === 'manage' ? 'Manage pins' : 'Add pin'} onClose={onClose}>
      {mode === 'manage' ? (
        <>
          <p className="workspace-muted">
            Change the order or remove a shortcut. The original stays where it is.
          </p>
          <ul className="home-pin-list">
            {pins.map((pin, index) => (
              <li key={`${pin.kind}:${pin.id}`}>
                <span>{recordTitle(pin.title)}</span>
                <div className="home-inline-actions">
                  <button
                    className="home-secondary"
                    type="button"
                    aria-label={`Move ${recordTitle(pin.title)} up`}
                    disabled={index === 0 || home.saving}
                    onClick={() => move(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    className="home-secondary"
                    type="button"
                    aria-label={`Move ${recordTitle(pin.title)} down`}
                    disabled={index === pins.length - 1 || home.saving}
                    onClick={() => move(index, 1)}
                  >
                    ↓
                  </button>
                  <button
                    className="home-secondary"
                    type="button"
                    aria-label={`Remove ${recordTitle(pin.title)}`}
                    disabled={home.saving}
                    onClick={() => setPins(pins.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {!pins.length && <p>No pins yet.</p>}
        </>
      ) : (
        <>
          <div className="home-inline-actions home-pin-tabs" role="group" aria-label="Pin type">
            <button
              className="home-secondary"
              type="button"
              aria-pressed={kind === 'session'}
              onClick={() => setKind('session')}
            >
              Sessions
            </button>
            <button
              className="home-secondary"
              type="button"
              aria-pressed={kind === 'telos'}
              onClick={() => setKind('telos')}
            >
              Work
            </button>
          </div>
          <label className="home-search">
            {kind === 'session' ? 'Find a session' : 'Find work'}
            <input
              type="search"
              value={kind === 'session' ? search.query : workQuery}
              onChange={(event) =>
                kind === 'session'
                  ? search.setQuery(event.target.value)
                  : setWorkQuery(event.target.value)
              }
            />
          </label>
          {kind === 'session' && search.error ? (
            <p role="alert">
              {search.error}{' '}
              <button className="home-secondary" onClick={search.retry}>
                Try again
              </button>
            </p>
          ) : kind === 'telos' && todos.error ? (
            <p role="alert">{todos.error}</p>
          ) : (kind === 'session' && search.searching) || (kind === 'telos' && todos.loading) ? (
            <p role="status">Loading…</p>
          ) : (
            <ul className="home-pin-list">
              {available.map((pin) => (
                <li key={pin.id}>
                  <span>{pin.title}</span>
                  <button
                    className="home-secondary"
                    aria-label={`Pin ${pin.title}`}
                    disabled={home.saving || pins.length >= 100}
                    onClick={() => void save([...pins, pin])}
                  >
                    Pin
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!available.length && !search.searching && !todos.loading && (
            <p className="workspace-muted">No unpinned items to show.</p>
          )}
        </>
      )}
      {home.error && <p role="alert">{home.error}</p>}
      <footer>
        <button className="home-secondary" type="button" onClick={onClose}>
          Cancel
        </button>
        {mode === 'manage' && (
          <button
            className="home-secondary"
            type="button"
            disabled={home.saving}
            onClick={() => void save(pins)}
          >
            Save pins
          </button>
        )}
      </footer>
    </HomeDialog>
  );
}
