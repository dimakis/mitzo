import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { WorkspacePageHeading } from '../components/WorkspacePageHeading';
import { UiIcon } from '../components/UiIcon';
import { EmptyState } from '../components/EmptyState';
import { HomeDialog } from '../components/HomeDialog';
import { useSavedChatDrafts } from '../hooks/useSavedChatDrafts';
import { chatDraftUrl, type ChatDraft } from '../lib/chat-drafts';
import { discardChatDraft } from '../lib/discard-chat-draft';
import { formatRelativeTime } from '../lib/formatTime';
import '../styles/chat-drafts.css';

export function DraftsView() {
  const drafts = useSavedChatDrafts();
  const mainRef = useRef<HTMLElement>(null);
  const [discard, setDiscard] = useState<ChatDraft | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const discardPending = useRef(false);
  const [error, setError] = useState('');
  return (
    <main className="workspace-page drafts-page" ref={mainRef}>
      <Link to="/sessions" className="drafts-back">
        <UiIcon name="back" size={16} /> Chats
      </Link>
      <WorkspacePageHeading
        title="Drafts"
        badge={drafts.length}
        description="Pick up where you left off."
        actions={
          <Link to="/chat" className="workspace-primary">
            <UiIcon name="plus" size={16} /> New chat
          </Link>
        }
      />
      <p className="workspace-muted">
        Messages, attachments, context and chat settings stay editable until you send. Saved on this
        device.
      </p>
      {error && !discard && <p role="alert">{error}</p>}
      {drafts.length ? (
        <div className="saved-draft-list">
          {drafts.map((draft) => (
            <article className="saved-draft-record" key={draft.id}>
              <Link to={chatDraftUrl(draft)} className="saved-draft-open">
                <div className="saved-draft-meta">
                  <span>Saved {formatRelativeTime(draft.updatedAt)}</span>
                  <UiIcon name="forward" size={16} />
                </div>
                <h2>{draft.text.trim().split('\n')[0].slice(0, 90) || 'Untitled draft'}</h2>
                <p className="saved-draft-excerpt">
                  {draft.text ||
                    (draft.settings.repositoryWorkspaceId &&
                    !draft.images.length &&
                    !draft.contextBlocks.length
                      ? 'Repository preparation saved.'
                      : 'Attachments and context ready to send.')}
                </p>
                <div className="saved-draft-settings">
                  <span>
                    {draft.settings.summary?.profile ??
                      draft.settings.selection?.accountId ??
                      'Choose an account'}
                  </span>
                  <span>
                    {draft.settings.summary?.model ??
                      draft.settings.selection?.model ??
                      'Choose a model'}
                  </span>
                  <span>
                    {draft.settings.summary?.thinking ??
                      `Thinking: ${draft.settings.selection?.reasoningEffort ?? 'model default'}`}
                  </span>
                </div>
                <span className="workspace-muted">
                  {draft.images.length} attachment{draft.images.length === 1 ? '' : 's'} ·{' '}
                  {draft.contextBlocks.length} context item
                  {draft.contextBlocks.length === 1 ? '' : 's'}
                </span>
              </Link>
              <button
                type="button"
                className="saved-draft-discard"
                onClick={(event) => {
                  event.currentTarget.focus();
                  setError('');
                  setDiscard(draft);
                }}
              >
                Discard draft
              </button>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<UiIcon name="edit" size={24} />}
          title="No drafts yet"
          subtitle="Unsent messages will appear here when you leave a new chat."
        />
      )}
      {discard && (
        <HomeDialog
          title="Discard this draft?"
          onClose={() => {
            if (!discardPending.current) setDiscard(null);
          }}
        >
          <p>The saved message, attachments and settings will be removed from this device.</p>
          {discard.settings.repositoryWorkspaceId && (
            <p>
              Its unused repository preparation will be released first. If its status is uncertain,
              the draft will be kept.
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          <div className="saved-draft-dialog-actions" aria-busy={discarding}>
            <button
              className="home-secondary"
              disabled={discarding}
              onClick={() => setDiscard(null)}
            >
              Keep draft
            </button>
            <button
              className="saved-draft-discard"
              disabled={discarding}
              onClick={async () => {
                if (discardPending.current) return;
                discardPending.current = true;
                setDiscarding(true);
                setError('');
                try {
                  await discardChatDraft(discard);
                  setDiscard(null);
                  requestAnimationFrame(() => {
                    const target =
                      mainRef.current?.querySelector<HTMLElement>('.saved-draft-open') ??
                      mainRef.current?.querySelector<HTMLElement>('.workspace-primary');
                    target?.focus();
                  });
                } catch (failure) {
                  setError(
                    failure instanceof Error
                      ? failure.message
                      : 'Couldn’t discard the draft. Try again.',
                  );
                } finally {
                  discardPending.current = false;
                  setDiscarding(false);
                }
              }}
            >
              {discarding ? 'Discarding…' : 'Confirm discard'}
            </button>
          </div>
        </HomeDialog>
      )}
    </main>
  );
}
