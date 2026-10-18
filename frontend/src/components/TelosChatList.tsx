import type { TelosWorkView } from '@mitzo/protocol';
import { telosChatRows, type TelosChatRow } from '../lib/telos-chat-rows';
import { UiIcon } from './UiIcon';
import './TelosChat.css';

/** Read-only selection surface. Ordinary role setup and source navigation remain
 * with their existing owners; opening this list never allocates or rebinds. */
export function TelosChatList({
  work,
  title,
  onOpen,
  onNewChat,
  onChangeAssignment,
}: {
  work: TelosWorkView;
  title: string;
  onOpen(row: TelosChatRow): void;
  onNewChat(): void;
  onChangeAssignment?(): void;
}) {
  const rows = telosChatRows(work);
  const role = work.kind === 'work_item' ? 'worker' : work.kind === 'outcome' ? 'lead' : null;
  const assigned = work.assignments.some((assignment) => assignment.role === role);
  return (
    <section className="telos-chat-list" aria-label={`Chats for ${title}`}>
      <h2>Chats · {rows.length}</h2>
      <div className="telos-chat-actions">
        {role && !assigned && onChangeAssignment && (
          <button type="button" onClick={onChangeAssignment}>
            Choose {role === 'lead' ? 'lead collaborator' : 'worker'}
          </button>
        )}
        <button type="button" onClick={onNewChat}>
          <UiIcon name="plus" size={16} />
          New chat
        </button>
      </div>
      {rows.length === 0 && <p>No linked conversations yet.</p>}
      <ul>
        {rows.map((row) => {
          const reviewedSource = row.sources.some(
            (source) =>
              source.selection.kind === 'selected' && source.source?.namespace === 'mitzo',
          );
          const available = row.availability === 'available' || reviewedSource;
          return (
            <li key={row.key}>
              <button
                type="button"
                className="telos-chat-row"
                disabled={!available}
                onClick={() => onOpen(row)}
                aria-label={`Open ${row.labels.join(' · ')}`}
              >
                <UiIcon name="chats" size={20} />
                <span className="telos-chat-copy">
                  <strong>{row.labels.join(' · ')}</strong>
                  <small>
                    {row.links[0]?.linkedAt
                      ? `Linked ${row.links[0].linkedAt}`
                      : 'Linked date unknown'}{' '}
                    · {row.links[0]?.linkedBy ?? 'Author unknown'}
                  </small>
                  {!available && (
                    <small>
                      {row.availability === 'unavailable' ? 'Unavailable' : 'Availability unknown'}
                    </small>
                  )}
                </span>
                <UiIcon name="arrowUpRight" size={16} />
              </button>
            </li>
          );
        })}
      </ul>
      {role && assigned && onChangeAssignment && (
        <button type="button" onClick={onChangeAssignment}>
          Change {role === 'lead' ? 'lead collaborator' : 'worker'}
        </button>
      )}
      <p className="telos-chat-note">
        Each chat retains its own history, settings and workspace. New chat keeps the assigned
        worker; Change worker assigns a replacement.
      </p>
    </section>
  );
}
