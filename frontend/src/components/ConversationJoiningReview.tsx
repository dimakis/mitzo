import type { ConversationAgent } from './ConversationAgents';
import type { useConversationJoiningReview } from '../hooks/useConversationJoiningReview';
import { UiIcon } from './UiIcon';
import {
  conversationArtifactKey,
  sameConversationArtifact,
} from '../lib/conversation-joining-artifacts';

export function ConversationJoiningReview({
  flow,
  agents,
  onAgents,
}: {
  flow: ReturnType<typeof useConversationJoiningReview>;
  agents: ConversationAgent[];
  onAgents(): void;
}) {
  const reviewed = flow.review;
  const snapshot = reviewed?.snapshot;
  const name = flow.setup?.name || 'Agent';
  const knownPolicies = agents.every((a) => a.policy);
  const responders = agents.filter((a) => a.policy?.replies).map((a) => a.name);
  return (
    <>
      <p className="conversation-agents-explanation">
        {name} joins with a fresh session. Its standard boot, agent and repository instructions stay
        separate from the context below.
      </p>
      {snapshot && (
        <>
          <div className="conversation-joining-context">
            <small>Context for the fresh agent</small>
            <strong>
              {snapshot.mode === 'selected' ? 'Selected context' : 'Conversation so far'}
            </strong>
            <small>
              {snapshot.messages.length} {snapshot.messages.length === 1 ? 'message' : 'messages'}
              {' · '}
              {snapshot.artifacts.length} artifact{' '}
              {snapshot.artifacts.length === 1 ? 'version' : 'versions'}
            </small>
          </div>
          <details className="conversation-joining-included">
            <summary>
              Review included context <UiIcon name="down" />
            </summary>
            {snapshot.messages.map((message) => (
              <div key={message.messageId} className="conversation-joining-message">
                <small>
                  {message.author === 'operator'
                    ? 'You'
                    : (agents.find(
                        (a) =>
                          a.id ===
                          (typeof message.author === 'object' ? message.author.sessionId : ''),
                      )?.name ?? 'Agent')}
                </small>
                {message.blocks.map((block) => (
                  <p key={block.blockId}>{block.content}</p>
                ))}
              </div>
            ))}
            {snapshot.summary && (
              <div className="conversation-joining-message">
                <small>{snapshot.summary.author} · Reviewed summary</small>
                <p>{snapshot.summary.content}</p>
              </div>
            )}
            {snapshot.artifacts.map((artifact) => {
              const label = reviewed.artifactLabels?.find((a) =>
                sameConversationArtifact(a, artifact),
              );
              const retained = 'kind' in artifact ? artifact : null;
              const title = retained?.title ?? label?.title;
              const filename = retained?.filename ?? label?.filename;
              return (
                <div
                  className="conversation-joining-context"
                  key={conversationArtifactKey(artifact)}
                >
                  <strong>{title}</strong>
                  <small>
                    Saved version {artifact.revision}
                    {filename ? ` · ${filename}` : ''}
                  </small>
                  {retained && (
                    <small>
                      Source chat {retained.provenance.sessionId}
                      {retained.provenance.sourcePath ? ` · ${retained.provenance.sourcePath}` : ''}
                    </small>
                  )}
                </div>
              );
            })}
            {snapshot.messages.length === 0 && snapshot.artifacts.length === 0 && (
              <p className="conversation-agents-explanation">
                Joining brief only. No earlier messages or artifacts selected.
              </p>
            )}
          </details>
          <label className="conversation-agent-field conversation-joining-brief">
            <span>Joining brief · sent to every participant</span>
            <textarea
              rows={6}
              maxLength={20_000}
              value={flow.brief}
              disabled={flow.locked}
              onChange={(event) => void flow.editBrief(event.target.value)}
            />
            <small className="conversation-agents-explanation">
              Included before each agent’s next requested response. Joining alone does not start a
              model response.
            </small>
          </label>
          <button
            type="button"
            className="conversation-agents-row conversation-joining-policy"
            onClick={onAgents}
          >
            <UiIcon name="eye" />
            <span>
              {knownPolicies
                ? `Shared discussion · ${responders.length ? `${responders.join(', ')} reply` : 'No default replies'}`
                : 'Agents'}
            </span>
            <UiIcon name="forward" />
          </button>
          {snapshot.capacity.status !== 'ready' && <p role="status">{snapshot.capacity.reason}</p>}
        </>
      )}
      {flow.pending && (
        <p role="status">
          {flow.pending === 'review' ? 'Checking joining brief…' : 'Checking joining…'}
        </p>
      )}
      {flow.join && (
        <p role="status">
          {name} {flow.join.state === 'linked' ? 'joined' : 'joining'}. Joining alone does not start
          a model response.
        </p>
      )}
      {flow.error && <p role="alert">{flow.error}</p>}
    </>
  );
}

export function ConversationJoiningReviewActions({
  flow,
  onBack,
}: {
  flow: ReturnType<typeof useConversationJoiningReview>;
  onBack(): void;
}) {
  return (
    <footer className="conversation-agents-footer conversation-joining-footer">
      <button type="button" onClick={onBack}>
        Back
      </button>
      {flow.join ? (
        (flow.join.state !== 'linked' || flow.requiresRecovery) && (
          <button type="button" disabled={!!flow.pending} onClick={() => void flow.recover()}>
            Check again
          </button>
        )
      ) : flow.uncertain ? (
        <button type="button" disabled={!!flow.pending} onClick={() => void flow.confirm()}>
          Check again
        </button>
      ) : flow.error ? (
        <button type="button" disabled={!!flow.pending} onClick={() => void flow.retryReview()}>
          Check again
        </button>
      ) : (
        <button
          type="button"
          className="conversation-agents-primary"
          disabled={!flow.canConfirm}
          onClick={() => void flow.confirm()}
        >
          Join conversation
        </button>
      )}
    </footer>
  );
}
