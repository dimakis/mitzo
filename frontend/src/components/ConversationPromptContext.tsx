import type { useConversationPromptContext } from '../hooks/useConversationPromptContext';
import { useMotionPresence } from '../hooks/useMotionPresence';
import { HomeDialog } from './HomeDialog';
import { UiIcon } from './UiIcon';
import './ConversationAgents.css';

export function ConversationPromptContext({
  flow,
  names,
  disabled,
}: {
  flow: ReturnType<typeof useConversationPromptContext>;
  names: Readonly<Record<string, string>>;
  disabled: boolean;
}) {
  const { ref, present } = useMotionPresence(flow.open, 'fade');
  const reviewed = flow.review;
  const snapshot = reviewed?.snapshot;
  return (
    <>
      <button
        type="button"
        className="chat-input-btn"
        aria-label="Review prompt context"
        title={flow.attached ? 'Reviewed context attached' : 'Review context for this prompt'}
        disabled={disabled || flow.unavailable}
        onClick={flow.show}
      >
        <UiIcon name="layers" />
      </button>
      {present && (
        <HomeDialog
          title="Context for this prompt"
          closeLabel="Close prompt context"
          className="conversation-agents-dialog"
          inactive={!flow.open}
          onClose={flow.close}
        >
          <div
            ref={ref}
            className="conversation-agents-body"
            inert={!flow.open}
            aria-hidden={!flow.open || undefined}
          >
            <p className="conversation-agents-explanation">
              Review the exact material shared with this prompt. Boot, agent and tool instructions
              stay separate.
            </p>
            <div className="conversation-joining-context">
              <small>Recipients</small>
              <strong>
                {flow.recipients.map((id) => names[id] ?? id).join(', ') || 'Choose who replies'}
              </strong>
              <small>
                Includes agents that read future discussion. Only selected responders take a turn.
              </small>
            </div>
            <label className="conversation-agent-field">
              Purpose
              <input
                value={flow.form.purpose}
                maxLength={4000}
                disabled={flow.busy || disabled}
                onChange={(e) => flow.edit({ ...flow.form, purpose: e.target.value })}
              />
            </label>
            <label className="conversation-agent-field">
              Context
              <select
                value={flow.form.mode}
                disabled={flow.busy || disabled}
                onChange={(e) =>
                  flow.edit({ ...flow.form, mode: e.target.value as typeof flow.form.mode })
                }
              >
                <option value="selected">Selected context</option>
                <option value="conversation_so_far">Conversation so far</option>
              </select>
            </label>
            {flow.form.mode === 'selected' ? (
              <fieldset className="conversation-context-selection" disabled={flow.busy || disabled}>
                <legend>Messages</legend>
                {!flow.source && (
                  <p>Source messages are unavailable. Close and open this review to check again.</p>
                )}
                {flow.source?.messages.map((message) => (
                  <label key={message.messageId}>
                    <input
                      type="checkbox"
                      checked={flow.form.messageIds.includes(message.messageId)}
                      onChange={(e) =>
                        flow.edit({
                          ...flow.form,
                          messageIds: e.target.checked
                            ? [...flow.form.messageIds, message.messageId]
                            : flow.form.messageIds.filter((id) => id !== message.messageId),
                        })
                      }
                    />
                    <span>
                      <small>{message.author === 'operator' ? 'You' : 'Agent'}</small>
                      {message.blocks.map((block) => block.content).join('\n')}
                    </span>
                  </label>
                ))}
              </fieldset>
            ) : (
              <p className="conversation-agents-explanation">
                Includes visible messages through the reviewed boundary and their referenced saved
                artifact versions.
              </p>
            )}
            <label className="conversation-agent-field">
              Brief
              <textarea
                value={flow.form.brief}
                maxLength={20000}
                disabled={flow.busy || disabled}
                onChange={(e) => flow.edit({ ...flow.form, brief: e.target.value })}
              />
            </label>
            {snapshot && (
              <>
                <div className="conversation-joining-context">
                  <small>Reviewed context</small>
                  <strong>{snapshot.purpose}</strong>
                  <small>
                    {snapshot.messages.length} messages · {snapshot.artifacts.length} saved artifact
                    versions
                  </small>
                </div>
                <details className="conversation-joining-included">
                  <summary>
                    Review included context <UiIcon name="down" />
                  </summary>
                  <p>{snapshot.joiningBrief}</p>
                  {snapshot.messages.map((message) => (
                    <div className="conversation-joining-message" key={message.messageId}>
                      <small>
                        {message.author === 'operator'
                          ? 'You'
                          : (names[message.author.sessionId] ?? 'Agent')}
                      </small>
                      {message.blocks.map((block) => (
                        <p key={block.blockId}>{block.content}</p>
                      ))}
                    </div>
                  ))}
                  {snapshot.artifacts.map((artifact) => (
                    <div
                      className="conversation-joining-context"
                      key={`${artifact.artifactId}:${artifact.revision}`}
                    >
                      <strong>
                        {reviewed?.artifactLabels?.find(
                          (label) =>
                            label.artifactId === artifact.artifactId &&
                            label.sha256 === artifact.sha256,
                        )?.title ?? artifact.artifactId}
                      </strong>
                      <small>Saved version {artifact.revision}</small>
                    </div>
                  ))}
                </details>
                <p className="conversation-agents-explanation">
                  {snapshot.capacity.status === 'unverified'
                    ? 'Capacity is unverified. The complete prompt is checked before admission; it may require narrower context.'
                    : snapshot.capacity.status === 'ready'
                      ? 'Context review is ready.'
                      : snapshot.capacity.reason}
                </p>
                {reviewed?.requiresReview && (
                  <p role="status">
                    The audience or settings changed. Review again before attaching.
                  </p>
                )}
              </>
            )}
            {flow.error && <p role="alert">{flow.error}</p>}
          </div>
          <footer className="conversation-agents-footer">
            <button type="button" onClick={flow.close}>
              Cancel
            </button>
            {flow.hasRetainedContext && (
              <button type="button" disabled={disabled || flow.busy} onClick={flow.remove}>
                Remove context
              </button>
            )}
            <button
              type="button"
              disabled={disabled || flow.busy || !flow.form.purpose.trim() || flow.unavailable}
              onClick={() => flow.reviewContext(false)}
            >
              {flow.hasRetainedReview ? 'Check original review' : 'Review context'}
            </button>
            {flow.hasRetainedReview && (
              <button
                type="button"
                disabled={disabled || flow.busy || flow.unavailable}
                onClick={() => flow.reviewContext(true)}
              >
                Review again
              </button>
            )}
            <button
              type="button"
              className="conversation-agents-primary"
              disabled={disabled || !flow.canAttach}
              onClick={flow.attach}
            >
              Attach reviewed context
            </button>
          </footer>
        </HomeDialog>
      )}
    </>
  );
}
