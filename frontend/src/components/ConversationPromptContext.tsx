import type { useConversationPromptContext } from '../hooks/useConversationPromptContext';
import type { CollaborationPromptReviewResult } from '@mitzo/protocol';
import type { useConversationForwarding } from '../hooks/useConversationForwarding';
import { useMotionPresence } from '../hooks/useMotionPresence';
import { HomeDialog } from './HomeDialog';
import { UiIcon } from './UiIcon';
import { ReviewedArtifactContents } from './ReviewedArtifactContents';
import './ConversationAgents.css';

function ReviewedContextContents({
  reviewed,
  names,
}: {
  reviewed: CollaborationPromptReviewResult;
  names: Readonly<Record<string, string>>;
}) {
  return (
    <>
      <p>{reviewed.snapshot.joiningBrief}</p>
      {reviewed.snapshot.messages.map((message) => (
        <div className="conversation-joining-message" key={message.messageId}>
          <small>
            {message.author === 'operator' ? 'You' : (names[message.author.sessionId] ?? 'Agent')}
          </small>
          {message.blocks.map((block) => (
            <p key={block.blockId}>{block.content}</p>
          ))}
        </div>
      ))}
      {reviewed.snapshot.artifacts.map((artifact) => (
        <div
          className="conversation-joining-context"
          key={`${artifact.artifactId}:${artifact.revision}`}
        >
          <strong>
            {reviewed.artifactLabels?.find(
              (label) =>
                label.artifactId === artifact.artifactId &&
                label.revision === artifact.revision &&
                label.sha256 === artifact.sha256,
            )?.title ?? artifact.artifactId}
          </strong>
          <small>Saved version {artifact.revision}</small>
          <ReviewedArtifactContents {...artifact} />
        </div>
      ))}
    </>
  );
}

export function ConversationPromptContext({
  flow,
  names,
  disabled,
  forwarding,
}: {
  flow: ReturnType<typeof useConversationPromptContext>;
  names: Readonly<Record<string, string>>;
  disabled: boolean;
  forwarding?: ReturnType<typeof useConversationForwarding>;
}) {
  const { ref, present } = useMotionPresence(flow.open, 'fade');
  const reviewed = flow.review;
  const snapshot = reviewed?.snapshot;
  const selectedArtifacts = flow.form.artifacts ?? [];
  const matches = (a: (typeof selectedArtifacts)[number], b: (typeof selectedArtifacts)[number]) =>
    a.artifactId === b.artifactId && a.revision === b.revision && a.sha256 === b.sha256;
  const artifacts = [
    ...(flow.artifacts ?? []),
    ...selectedArtifacts
      .filter((pin) => !flow.artifacts?.some((artifact) => matches(pin, artifact)))
      .map((pin) => ({ ...pin, title: 'Previously selected artifact', available: false })),
  ];
  return (
    <>
      <button
        type="button"
        className="chat-input-btn"
        aria-label="Review prompt context"
        title={flow.attached ? 'Reviewed context attached' : 'Review context for this prompt'}
        disabled={disabled || flow.unavailable}
        onClick={(event) => {
          event.currentTarget.focus();
          flow.show();
        }}
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
            {flow.form.mode === 'selected' && (
              <fieldset className="conversation-context-selection" disabled={flow.busy || disabled}>
                <legend>Saved artifact versions</legend>
                {artifacts.length === 0 && <p>No registered artifacts in this conversation.</p>}
                <p>
                  Shows up to 50 recent registered versions. Older selections remain below until
                  removed.
                </p>
                {artifacts.map((artifact) => (
                  <label key={`${artifact.artifactId}:${artifact.revision}:${artifact.sha256}`}>
                    <input
                      type="checkbox"
                      disabled={
                        !artifact.available &&
                        !selectedArtifacts.some((pin) => matches(pin, artifact))
                      }
                      checked={selectedArtifacts.some((pin) => matches(pin, artifact))}
                      onChange={(e) =>
                        flow.edit({
                          ...flow.form,
                          artifacts: e.target.checked
                            ? [
                                ...(flow.form.artifacts ?? []),
                                {
                                  artifactId: artifact.artifactId,
                                  revision: artifact.revision,
                                  sha256: artifact.sha256,
                                },
                              ]
                            : (flow.form.artifacts ?? []).filter(
                                (pin) =>
                                  pin.artifactId !== artifact.artifactId ||
                                  pin.revision !== artifact.revision ||
                                  pin.sha256 !== artifact.sha256,
                              ),
                        })
                      }
                    />
                    <span>
                      {artifact.title}
                      <small>
                        Saved version {artifact.revision}
                        {!artifact.available && ' · unavailable'}
                      </small>
                    </span>
                  </label>
                ))}
              </fieldset>
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
            {snapshot && reviewed && (
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
                  <ReviewedContextContents reviewed={reviewed} names={names} />
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
            {forwarding && (
              <section
                className="conversation-joining-context"
                aria-label="Forward reviewed context"
              >
                <strong>Forward context only</strong>
                <p>
                  Share the exact reviewed messages and saved versions with their reviewed
                  recipients. The brief accompanies them. No reply starts; recipients receive this
                  context before their next requested turn. Your prompt draft stays here.
                </p>
                {forwarding.observation?.state === 'confirmed' ? (
                  <p role="status">
                    Forward recorded. Delivery remains visible in the conversation.
                  </p>
                ) : forwarding.uncertain ? (
                  <p role="status">
                    Forwarding is not confirmed. Check the original request before taking another
                    action.
                  </p>
                ) : forwarding.retained ? (
                  <p role="status">
                    Inspect the original reviewed context, then confirm this forward.
                  </p>
                ) : null}
                {forwarding.originalReview && (
                  <section aria-label="Original forward context">
                    <small>Original forward recipients</small>
                    <strong>
                      {forwarding.originalRecipients.map((id) => names[id] ?? id).join(', ')}
                    </strong>
                    <p>{forwarding.originalReview.snapshot.purpose}</p>
                    <ReviewedContextContents reviewed={forwarding.originalReview} names={names} />
                    {!forwarding.canConfirm &&
                      !forwarding.busy &&
                      forwarding.observation?.state !== 'confirmed' && (
                        <p role="status">
                          The original context cannot be confirmed with the current audience or
                          settings.
                        </p>
                      )}
                  </section>
                )}
                {forwarding.error && <p role="alert">{forwarding.error}</p>}
                {!forwarding.retained ? (
                  <button
                    type="button"
                    disabled={disabled || forwarding.busy || !forwarding.canPrepare}
                    onClick={forwarding.prepare}
                  >
                    Prepare context forward
                  </button>
                ) : (
                  <>
                    <button type="button" disabled={forwarding.busy} onClick={forwarding.check}>
                      Check original forward
                    </button>
                    {forwarding.observation?.state !== 'confirmed' && (
                      <>
                        <button
                          type="button"
                          disabled={disabled || !forwarding.canInspect}
                          onClick={forwarding.inspect}
                        >
                          Inspect original context
                        </button>
                        <button
                          type="button"
                          disabled={disabled || !forwarding.canConfirm}
                          onClick={forwarding.confirm}
                        >
                          Confirm context forward
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      disabled={!forwarding.canClear}
                      onClick={forwarding.clear}
                    >
                      {forwarding.observation?.state === 'confirmed'
                        ? 'Dismiss forwarding receipt'
                        : 'Discard preparation'}
                    </button>
                  </>
                )}
              </section>
            )}
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
