import { TelosSourceConversationReferenceSchema, type TelosWorkView } from '@mitzo/protocol';
import { telosChatRows, type TelosChatRow } from '../lib/telos-chat-rows';
import { UiIcon } from './UiIcon';
import './TelosChat.css';
export type TelosChatDetails = Record<string, { title?: string; description?: string }>;

/** Read-only selection surface. Ordinary role setup and source navigation remain
 * with their existing owners; opening this list never allocates or rebinds. */
export function TelosChatList({
  work,
  title,
  onOpen,
  onNewChat,
  onChangeAssignment,
  details = {},
}: {
  work: TelosWorkView;
  title: string;
  onOpen(row: TelosChatRow): void;
  onNewChat(): void;
  onChangeAssignment?(): void;
  details?: TelosChatDetails;
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
          // External origins retain their explicit source opener even though
          // ordinary Mitzo availability is unknown. This does not admit a chat.
          const externalOrigin =
            row.conversation.namespace === 'external_codex' &&
            TelosSourceConversationReferenceSchema.safeParse(row.conversation).success;
          const canOpen = row.availability === 'available' || reviewedSource || externalOrigin;
          return (
            <li key={row.key}>
              <button
                type="button"
                className="telos-chat-row"
                disabled={!canOpen}
                onClick={() => onOpen(row)}
                aria-label={`Open ${row.labels.join(' · ')}${details[row.key]?.title ? ': ' + details[row.key].title : ''}`}
              >
                <UiIcon name="chats" size={20} />
                <span className="telos-chat-copy">
                  <strong>{details[row.key]?.title ?? row.labels.join(' · ')}</strong>
                  {details[row.key]?.title && <small>{row.labels.join(' · ')}</small>}
                  {details[row.key]?.description && <small>{details[row.key].description}</small>}
                  <small>
                    {row.links[0]?.linkedAt
                      ? `Linked ${row.links[0].linkedAt}`
                      : 'Linked date unknown'}{' '}
                    · {row.links[0]?.linkedBy ?? 'Author unknown'}
                  </small>
                  {!canOpen && (
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
