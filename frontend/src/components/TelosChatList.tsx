import { TelosSourceConversationReferenceSchema, type TelosWorkView } from '@mitzo/protocol';
import { telosChatRows, type TelosChatRow } from '../lib/telos-chat-rows';
import { UiIcon } from './UiIcon';
import { telosWorkEntryRole } from '../lib/telos-work-entry-role';
import './TelosChat.css';
export type TelosChatDetails = Record<
  string,
  {
    title?: string;
    description?: string;
    accountModel?: string;
    profileTarget?: string;
    createdAt?: number;
  }
>;

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
  const role = telosWorkEntryRole(work.kind);
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
          const historyNotice = row.unknownAssignmentRoles
            ?.map((role) => `${role[0].toUpperCase() + role.slice(1)} assignment history unknown`)
            .join(' · ');
          const detail = details[row.key];
          const created =
            typeof detail?.createdAt === 'number' &&
            Number.isSafeInteger(detail.createdAt) &&
            detail.createdAt >= 0 &&
            Number.isFinite(new Date(detail.createdAt).getTime())
              ? new Date(detail.createdAt)
              : undefined;
          return (
            <li key={row.key}>
              <button
                type="button"
                className="telos-chat-row"
                disabled={!canOpen}
                onClick={() => onOpen(row)}
                aria-label={`Open ${row.labels.join(' · ')}${details[row.key]?.title ? ': ' + details[row.key].title : ''}`}
                aria-description={historyNotice || undefined}
              >
                <UiIcon name="chats" size={20} />
                <span className="telos-chat-copy">
                  <strong>{details[row.key]?.title ?? row.labels.join(' · ')}</strong>
                  {(detail?.title || detail?.accountModel) && (
                    <span className="telos-chat-role-settings">
                      {detail?.title && <small>{row.labels.join(' · ')}</small>}
                      {detail?.accountModel && (
                        <span>
                          {detail.title ? ' · ' : ''}
                          {detail.accountModel}
                        </span>
                      )}
                    </span>
                  )}
                  {historyNotice && <small>{historyNotice}</small>}
                  {detail?.description && !detail.accountModel && !detail.profileTarget && (
                    <small>{detail.description}</small>
                  )}
                  <small>
                    {detail?.profileTarget && <>{detail.profileTarget} · </>}
                    {created ? (
                      <time dateTime={created.toISOString()}>
                        Created{' '}
                        {created.toLocaleDateString(undefined, {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                        })}
                      </time>
                    ) : (
                      'Created date unavailable'
                    )}
                  </small>
                  {!canOpen && (
                    <small>
                      {row.availability === 'unavailable' ? 'Unavailable' : 'Availability unknown'}
                    </small>
                  )}
                </span>
                <UiIcon name="arrowUpRight" size={16} />
              </button>
              {(row.links.length > 0 || row.sources.length > 0) && (
                <details className="telos-chat-provenance">
                  <summary>Conversation provenance</summary>
                  <dl>
                    {row.links.map((link) => (
                      <div key={link.linkId}>
                        <dt>Recorded {link.role} link</dt>
                        <dd>
                          {link.linkedAt ? `Linked ${link.linkedAt}` : 'Linked date unknown'} ·{' '}
                          {link.linkedBy ?? 'Author unknown'}
                        </dd>
                      </div>
                    ))}
                    {row.sources.map((source) => (
                      <div key={source.snapshotId}>
                        <dt>Source snapshot {source.snapshotId}</dt>
                        <dd>
                          Conversation created {source.sourceCreatedAt ?? 'date unknown'} ·{' '}
                          {source.author ?? 'Author unknown'}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </details>
              )}
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
        Each chat retains its own history, settings and workspace. New chat keeps the assigned{' '}
        {role === 'lead' ? 'lead collaborator' : 'worker'}; Change{' '}
        {role === 'lead' ? 'lead collaborator' : 'worker'} assigns a replacement.
      </p>
    </section>
  );
}
