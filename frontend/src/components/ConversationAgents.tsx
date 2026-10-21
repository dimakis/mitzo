import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type { FinishedMessage } from '@mitzo/protocol';
import type {
  ConversationAgentSetup,
  ConversationArtifactOption,
  ConversationJoiningOwner,
} from '../lib/conversation-joining-review';
import { useConversationJoiningReview } from '../hooks/useConversationJoiningReview';
import type { useConversationJoiningCatalog } from '../hooks/useConversationJoiningCatalog';
import { initialConversationJoiningBrief } from '../lib/conversation-joining-brief';
import {
  conversationArtifactKey,
  conversationArtifactPin,
  sameConversationArtifact,
} from '../lib/conversation-joining-artifacts';
import {
  ConversationJoiningReview,
  ConversationJoiningReviewActions,
} from './ConversationJoiningReview';
import { HomeDialog } from './HomeDialog';
import { useMotionPresence } from '../hooks/useMotionPresence';
import { UiIcon } from './UiIcon';
import { AccountModelPicker } from './AccountModelPicker';
import { ChatAgentProfilePicker } from './ChatAgentProfilePicker';
import { QuickSettingsContext } from '../lib/quick-settings-context';
import './ConversationAgents.css';

export interface ConversationAgent {
  id: string;
  name: string;
  account?: string;
  model?: string;
  thinking?: string;
  location?: string;
  state: string;
  policy?: { reads: boolean; replies: boolean };
}
const initial = (): ConversationAgentSetup => ({
  name: '',
  purpose: '',
  context: 'conversation_so_far',
  messageIds: [],
  artifacts: [],
  runOn: 'openshell',
  selection: null,
  agent: null,
});

/** Presentation shared by ordinary and retained conversations. No allocation or dispatch.
 * A missing policy/join owner is unavailable, never a local simulation of acceptance.
 */
export function ConversationAgents(props: {
  scope: string;
  agents: ConversationAgent[];
  messages: FinishedMessage[];
  conversationTitle?: string;
  repository?: string;
  compact?: boolean;
  leading?: ReactNode;
  actions?: ReactNode;
  settings?: ReactNode;
  onPreview?(id: string): void;
  onDraftProfile?(id: string): void;
  unavailableReason?: string;
  /** Checks metadata or the original relationship request; never prepares a target or starts a response. */
  onRetryJoiningSetup?(): void;
  /** Explicit Add may begin only the original relationship; never a model turn. */
  onAddAgent?(): void;
  renderPreview?(agent: ConversationAgent): ReactNode;
  onPolicyChange?(id: string, policy: { reads: boolean; replies: boolean }): void;
  /** Confirmed policy state and explicit recovery controls from the existing owner. */
  policyFeedback?: ReactNode;
  policyUnavailableReason?: string;
  /** Supplied only when real source, capacity and ordinary preparation owners exist. */
  joiningOwner?: ConversationJoiningOwner;
  /** Authenticated source metadata, independent of joining readiness. */
  joiningCatalog?: ReturnType<typeof useConversationJoiningCatalog>;
}) {
  // A route change synchronously retires the dialog, callbacks and private setup.
  return <ConversationAgentsBody key={props.scope} {...props} />;
}
/** The query box is the available conversation width, before the header's own gutter. */
function ParticipantHeaderFrame({ compact, children }: { compact?: boolean; children: ReactNode }) {
  return compact ? children : <div className="conversation-participants-container">{children}</div>;
}
/** Portals inherit React context. This independent dialog owns its settings,
 * rather than routing rows into an enclosing ordinary chat settings sheet. */
function ConversationAgentsDialog(props: Parameters<typeof HomeDialog>[0]) {
  return (
    <QuickSettingsContext.Provider value={null}>
      <HomeDialog {...props} />
    </QuickSettingsContext.Provider>
  );
}
function ConversationAgentsBody({
  agents,
  messages,
  conversationTitle,
  repository,
  compact,
  leading,
  actions,
  settings,
  onPreview,
  onDraftProfile,
  unavailableReason,
  onRetryJoiningSetup,
  onAddAgent,
  renderPreview,
  onPolicyChange,
  policyFeedback,
  policyUnavailableReason,
  joiningOwner,
  joiningCatalog,
}: Parameters<typeof ConversationAgents>[0]) {
  const [view, setView] = useState<
    'agents' | 'add' | 'review' | 'settings' | 'preview' | 'details'
  >('agents');
  const [open, setOpen] = useState(false);
  const addAgentTrigger = useRef<HTMLButtonElement>(null);
  const restoreAgentsFocus = useRef(false);
  const returnToAgents = () => {
    restoreAgentsFocus.current = true;
    setView('agents');
  };
  useEffect(() => {
    if (view === 'agents' && restoreAgentsFocus.current) {
      restoreAgentsFocus.current = false;
      addAgentTrigger.current?.focus({ preventScroll: true });
    }
  }, [view]);
  const { ref: dialogMotionRef, present } = useMotionPresence(open, 'fade');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewAgent = agents.find((agent) => agent.id === previewId);
  const [profileReason, setProfileReason] = useState<string>();
  const setupStatus = useRef<HTMLParagraphElement>(null);
  const restoreSetupFocus = useRef(false);
  const catalogStatus = useRef<HTMLParagraphElement>(null);
  const restoreCatalogFocus = useRef(false);
  useEffect(() => {
    if (restoreCatalogFocus.current) {
      restoreCatalogFocus.current = false;
      catalogStatus.current?.focus({ preventScroll: true });
    }
  }, [
    joiningCatalog?.pending,
    joiningCatalog?.artifacts,
    joiningCatalog?.reason,
    joiningCatalog?.hasMore,
  ]);
  useEffect(() => {
    if (!onRetryJoiningSetup && restoreSetupFocus.current) {
      restoreSetupFocus.current = false;
      setupStatus.current?.focus({ preventScroll: true });
    }
  }, [onRetryJoiningSetup]);
  const joining = useConversationJoiningReview(joiningOwner, (join) => {
    joiningOwner?.onLinked?.(join);
    setOpen(false);
    setView('agents');
    setSetup(initial());
    setProfileReason(undefined);
  });
  const [setup, setSetup] = useState(() =>
    joining.setup ? structuredClone(joining.setup) : initial(),
  );
  const metadataScope = joiningCatalog?.scope ?? joiningOwner?.sourceConversationId;
  const [selectedLabels, setSelectedLabels] = useState<{
    scope: typeof metadataScope;
    artifacts: ConversationArtifactOption[];
  }>({ scope: metadataScope, artifacts: [] });
  useEffect(() => {
    setSelectedLabels((previous) =>
      previous.scope === metadataScope ? previous : { scope: metadataScope, artifacts: [] },
    );
  }, [metadataScope]);
  const availableArtifacts = [...(joiningCatalog?.artifacts ?? joiningOwner?.artifacts ?? [])];
  if (selectedLabels.scope === metadataScope)
    for (const artifact of selectedLabels.artifacts)
      if (
        setup.artifacts.some((pin) => sameConversationArtifact(pin, artifact)) &&
        !availableArtifacts.some((candidate) => sameConversationArtifact(candidate, artifact))
      )
        availableArtifacts.push(artifact);
  const restoredSetup = joining.restoredSetup;
  useEffect(() => {
    if (restoredSetup) setSetup(structuredClone(restoredSetup));
  }, [restoredSetup]);
  const names = agents.map((a) => a.name).join(', ');
  const headerAgents = agents.slice(0, 2);
  const nameValid =
    /^[A-Za-z][A-Za-z0-9_-]{0,23}$/.test(setup.name) &&
    setup.name.toLowerCase() !== 'all' &&
    !agents.some((a) => a.name.toLowerCase() === setup.name.toLowerCase());
  const reviewSetup = joiningCatalog?.catalog?.sourceRepository
    ? { ...setup, sourceRepository: joiningCatalog.catalog.sourceRepository.repository }
    : setup;
  const title =
    view === 'add'
      ? 'Add agent'
      : view === 'review'
        ? 'Before joining'
        : view === 'settings'
          ? 'Chat settings'
          : view === 'preview'
            ? `${previewAgent?.name ?? 'Agent'} conversation`
            : view === 'details'
              ? (previewAgent?.name ?? 'Agent details')
              : 'Agents';
  const selectable = joiningCatalog
    ? joiningCatalog.messages
        .filter((m) => m.blocks.some((b) => b.content))
        .map((m) => ({
          messageId: m.messageId,
          author:
            m.author === 'operator'
              ? 'You'
              : (agents.find(
                  (agent) => typeof m.author === 'object' && agent.id === m.author.sessionId,
                )?.name ?? 'Agent'),
          text: m.blocks.map((b) => b.content).join('\n'),
        }))
    : messages
        .filter((m) => m.blocks.some((b) => b.blockType === 'text' && b.content))
        .map((m) => ({
          messageId: m.messageId,
          author:
            m.role === 'user'
              ? 'You'
              : m.symposiumProvenance && 'seatLabel' in m.symposiumProvenance
                ? m.symposiumProvenance.seatLabel
                : 'Agent',
          text: m.blocks
            .filter((b) => b.blockType === 'text')
            .map((b) => b.content)
            .join('\n'),
        }));
  const requestCatalog = (action: () => void | Promise<void>) => {
    restoreCatalogFocus.current = true;
    void action();
  };
  // No freshness, capacity, allocation or provider readiness is inferred from catalog data.
  const unavailable =
    unavailableReason ??
    'Fresh agents are not available in this conversation yet. Your setup stays here.';
  return (
    <>
      <ParticipantHeaderFrame compact={compact}>
        <div
          className={
            compact
              ? 'conversation-agents-entry'
              : `conversation-participants${leading ? ' workspace-controls--navigation' : ''}`
          }
        >
          {leading}
          <button
            type="button"
            className="conversation-participants-trigger"
            aria-label={`Agents${names ? ', ' + names : ''}`}
            aria-expanded={open}
            onClick={(event) => {
              event.currentTarget.focus();
              setView('agents');
              setOpen(true);
            }}
          >
            <UiIcon name={agents.length > 1 ? 'agents' : 'bot'} />
            {!compact && (
              <span>
                <strong>
                  <span className="conversation-participant-names">
                    {headerAgents.map((a) => a.name).join(' · ')
                      ? headerAgents.map((agent, index) => (
                          <span
                            key={agent.id}
                            className={
                              index === 1 ? 'conversation-participant-additional-name' : undefined
                            }
                          >
                            {index === 1 ? ' · ' : ''}
                            {agent.name}
                          </span>
                        ))
                      : 'Agents'}
                  </span>
                  {agents.length > 2 && (
                    <span className="conversation-participant-wide-count">
                      +{agents.length - 2}
                    </span>
                  )}
                  {agents.length > 1 && (
                    <span className="conversation-participant-count">+{agents.length - 1}</span>
                  )}
                </strong>
                <small>{agents.length > 1 ? 'Shared discussion' : 'Agent chat'}</small>
              </span>
            )}
            {compact && <span>Agents</span>}
            <UiIcon name="down" />
          </button>
          {actions}
        </div>
      </ParticipantHeaderFrame>
      {present && (
        <ConversationAgentsDialog
          title={title}
          closeLabel="Close Agents"
          inactive={!open}
          onClose={() => setOpen(false)}
          className={`conversation-agents-dialog${view === 'review' ? ' conversation-joining-dialog' : view === 'add' ? ' conversation-add-dialog' : ''}`}
          onBack={
            view === 'review'
              ? () => setView(joining.locked ? 'agents' : 'add')
              : view === 'add'
                ? returnToAgents
                : undefined
          }
          backLabel={view === 'add' ? 'Back to Agents' : 'Back from joining review'}
        >
          <div
            ref={dialogMotionRef}
            className="conversation-agents-body"
            inert={!open}
            aria-hidden={!open || undefined}
          >
            {view === 'agents' && (
              <>
                <p className="conversation-agents-explanation">
                  Choose who reads future discussion and who replies by default. @ changes who
                  replies to one prompt.
                </p>
                {policyFeedback && (
                  <div className="conversation-policy-feedback">{policyFeedback}</div>
                )}
                {agents.length === 0 && <p role="status">Agent details are loading.</p>}
                {agents.map((a) => (
                  <article className="conversation-agent-record" key={a.id}>
                    <div className="conversation-agent-heading">
                      <UiIcon name="bot" />
                      <div>
                        <strong>{a.name}</strong>
                        <small>
                          {[a.account, a.model, a.thinking].filter(Boolean).join(' · ') ||
                            'Settings unavailable'}
                        </small>
                      </div>
                      {(onPreview || renderPreview) && (
                        <button
                          type="button"
                          aria-label={`Preview ${a.name} conversation`}
                          onClick={() => {
                            if (renderPreview) {
                              setPreviewId(a.id);
                              setView('preview');
                            } else {
                              onPreview?.(a.id);
                              setOpen(false);
                            }
                          }}
                        >
                          <UiIcon name="eye" />
                        </button>
                      )}
                    </div>
                    <p className="conversation-agent-state">
                      {[a.location, a.state].filter(Boolean).join(' · ')}
                    </p>
                    <fieldset className="conversation-agent-policy">
                      <legend className="sr-only">Sharing for {a.name}</legend>
                      <label>
                        <input
                          type="checkbox"
                          checked={a.policy?.reads ?? false}
                          disabled={!a.policy || !onPolicyChange}
                          onChange={(e) =>
                            a.policy &&
                            onPolicyChange?.(a.id, { ...a.policy, reads: e.target.checked })
                          }
                        />
                        <span>Reads future discussion</span>
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={a.policy?.replies ?? false}
                          disabled={!a.policy || !onPolicyChange}
                          onChange={(e) =>
                            a.policy &&
                            onPolicyChange?.(a.id, { ...a.policy, replies: e.target.checked })
                          }
                        />
                        <span>Replies by default</span>
                      </label>
                    </fieldset>
                    {(!a.policy || !onPolicyChange) && (
                      <small>
                        {policyUnavailableReason ??
                          'Discussion sharing settings are not available for this agent yet.'}
                      </small>
                    )}
                    <button
                      type="button"
                      className="conversation-agents-row"
                      aria-label={`Details for ${a.name}`}
                      onClick={() => {
                        setPreviewId(a.id);
                        setView('details');
                      }}
                    >
                      Details <UiIcon name="right" />
                    </button>
                  </article>
                ))}
                <details>
                  <summary>About sharing</summary>
                  <p>
                    An addressed agent receives its prompt and replies. Reading shared discussion
                    does not start another reply. Changes apply to future messages.
                  </p>
                </details>
                {settings && (
                  <button
                    className="conversation-agents-row"
                    type="button"
                    onClick={() => setView('settings')}
                  >
                    Chat settings <UiIcon name="right" />
                  </button>
                )}
              </>
            )}
            {view === 'details' &&
              (previewAgent ? (
                <>
                  <dl className="conversation-agent-facts">
                    <dt>Account</dt>
                    <dd>{previewAgent.account || 'Not reported'}</dd>
                    <dt>Model</dt>
                    <dd>{previewAgent.model || 'Not reported'}</dd>
                    <dt>Thinking</dt>
                    <dd>{previewAgent.thinking || 'Not reported'}</dd>
                    <dt>Run on</dt>
                    <dd>{previewAgent.location || 'Not reported'}</dd>
                    <dt>State</dt>
                    <dd>{previewAgent.state}</dd>
                  </dl>
                  {onDraftProfile && (
                    <button
                      type="button"
                      className="conversation-agents-row"
                      onClick={() => {
                        onDraftProfile(previewAgent.id);
                        setOpen(false);
                      }}
                    >
                      Draft reusable profile from this agent
                    </button>
                  )}
                </>
              ) : (
                <p role="status">This agent is no longer available.</p>
              ))}
            {view === 'settings' && settings}
            {view === 'preview' &&
              (previewAgent ? (
                renderPreview?.(previewAgent)
              ) : (
                <p role="status">This agent is no longer available.</p>
              ))}
            {view === 'add' && (
              <>
                <p className="conversation-agents-explanation">
                  A fresh session with its own account, model and environment.
                </p>
                <ChatAgentProfilePicker
                  sessionId={null}
                  search={
                    setup.agent
                      ? new URLSearchParams({
                          agentProfile: setup.agent.profileId,
                          profileRevision: String(setup.agent.revision),
                          ...(setup.agent.kind ? { agentProfileKind: setup.agent.kind } : {}),
                        }).toString()
                      : ''
                  }
                  updateSearchParams={false}
                  label="Agent"
                  onChange={(agent, reason) => {
                    setSetup((s) => ({ ...s, agent }));
                    setProfileReason(reason);
                  }}
                />
                <label className="conversation-agent-field">
                  Name in this chat
                  <input
                    value={setup.name}
                    maxLength={24}
                    onChange={(e) => setSetup((s) => ({ ...s, name: e.target.value }))}
                  />
                </label>
                <h3>Account &amp; model</h3>
                <AccountModelPicker
                  sessionId={null}
                  preferredModel=""
                  draftOnly
                  presentation="settings"
                  initialSelection={setup.selection ?? undefined}
                  onDraftSelectionChange={(selection) => setSetup((s) => ({ ...s, selection }))}
                  onChange={(selection) => {
                    if (selection) setSetup((s) => ({ ...s, selection }));
                  }}
                />
                <h3>Execution</h3>
                <fieldset className="conversation-agent-run-on">
                  <legend>Run on</legend>
                  {(['local', 'openshell'] as const).map((runOn) => (
                    <label key={runOn}>
                      <input
                        type="radio"
                        name="fresh-agent-run-on"
                        value={runOn}
                        checked={setup.runOn === runOn}
                        onChange={() => setSetup((s) => ({ ...s, runOn }))}
                      />
                      <UiIcon name={runOn === 'local' ? 'laptop' : 'box'} />
                      <span>{runOn === 'local' ? 'Mac host' : 'OpenShell'}</span>
                    </label>
                  ))}
                </fieldset>
                <div className="conversation-agent-field">
                  <span>Repository</span>
                  <strong>
                    {joiningCatalog
                      ? (joiningCatalog.catalog?.sourceRepository?.repository ?? 'Not verified')
                      : repository || 'Not selected'}
                  </strong>
                </div>
                <h3>Starting context</h3>
                <label className="conversation-agent-field">
                  Context
                  <select
                    className="chat-model-select"
                    value={setup.context}
                    onChange={(e) =>
                      setSetup((s) => ({
                        ...s,
                        context: e.target.value as ConversationAgentSetup['context'],
                      }))
                    }
                  >
                    <option value="conversation_so_far">Conversation so far</option>
                    <option value="selected">Selected context</option>
                  </select>
                </label>
                {setup.context === 'conversation_so_far' ? (
                  <p className="conversation-agents-explanation">
                    Messages in this conversation up to the joining point, with their referenced
                    artifact versions.
                  </p>
                ) : (
                  <>
                    <p className="conversation-agents-explanation">
                      Choose messages and saved artifact versions. Leave all unchecked for the
                      joining brief only.
                    </p>
                    <fieldset className="conversation-context-selection">
                      <legend>Messages</legend>
                      {selectable.length === 0 && (!joiningCatalog || joiningCatalog.catalog) && (
                        <p>No messages yet.</p>
                      )}
                      {selectable.map((m) => (
                        <label key={m.messageId}>
                          <input
                            type="checkbox"
                            checked={setup.messageIds.includes(m.messageId)}
                            onChange={(e) =>
                              setSetup((s) => ({
                                ...s,
                                messageIds: e.target.checked
                                  ? [...s.messageIds, m.messageId]
                                  : s.messageIds.filter((id) => id !== m.messageId),
                              }))
                            }
                          />
                          <span>
                            <small>{m.author}</small>
                            {m.text}
                          </span>
                        </label>
                      ))}
                    </fieldset>
                    {joiningCatalog || joiningOwner?.artifacts ? (
                      <fieldset className="conversation-context-selection">
                        <legend>Artifacts</legend>
                        {availableArtifacts.length === 0 &&
                          (!joiningCatalog || joiningCatalog.catalog) && (
                            <p>No artifacts in this conversation.</p>
                          )}
                        {availableArtifacts.map((artifact, index) => (
                          <Fragment key={conversationArtifactKey(artifact)}>
                            <label>
                              <input
                                type="checkbox"
                                checked={setup.artifacts.some((a) =>
                                  sameConversationArtifact(a, artifact),
                                )}
                                onChange={(event) => {
                                  const checked = event.target.checked;
                                  setSelectedLabels((previous) => ({
                                    scope: metadataScope,
                                    artifacts: [
                                      ...(previous.scope === metadataScope
                                        ? previous.artifacts
                                        : []
                                      ).filter((pin) => !sameConversationArtifact(pin, artifact)),
                                      ...(checked ? [artifact] : []),
                                    ],
                                  }));
                                  setSetup((s) => ({
                                    ...s,
                                    artifacts: checked
                                      ? [...s.artifacts, conversationArtifactPin(artifact)]
                                      : s.artifacts.filter(
                                          (a) => !sameConversationArtifact(a, artifact),
                                        ),
                                  }));
                                }}
                              />
                              <span>
                                {artifact.title}
                                <small>
                                  Saved version {artifact.revision}
                                  {artifact.filename ? ` · ${artifact.filename}` : ''}
                                </small>
                              </span>
                            </label>
                            {joiningCatalog &&
                              'kind' in artifact &&
                              !availableArtifacts
                                .slice(0, index)
                                .some(
                                  (previous) =>
                                    'kind' in previous &&
                                    previous.artifactId === artifact.artifactId,
                                ) &&
                              joiningCatalog.hasEarlier(artifact) && (
                                <button
                                  type="button"
                                  className="conversation-agents-row"
                                  disabled={
                                    joiningCatalog.pending ||
                                    !joiningCatalog.catalog ||
                                    joiningCatalog.catalog.retainedAvailability !== 'available'
                                  }
                                  onClick={() =>
                                    requestCatalog(() => joiningCatalog.loadEarlier(artifact))
                                  }
                                >
                                  <span>Earlier saved versions of {artifact.title}</span>
                                </button>
                              )}
                          </Fragment>
                        ))}
                        {joiningCatalog?.hasMore && (
                          <button
                            type="button"
                            className="conversation-agents-row"
                            disabled={joiningCatalog.pending}
                            onClick={() => requestCatalog(joiningCatalog.loadMore)}
                          >
                            More saved artifacts
                          </button>
                        )}
                      </fieldset>
                    ) : (
                      <p className="conversation-agents-explanation">
                        Saved artifact versions are not available for selection yet.
                      </p>
                    )}
                    {joiningCatalog && (
                      <>
                        <p
                          ref={catalogStatus}
                          tabIndex={-1}
                          role="status"
                          className="conversation-agents-explanation"
                        >
                          {joiningCatalog.pending
                            ? 'Checking saved context…'
                            : (joiningCatalog.reason ??
                              'Choose exact saved versions for this agent.')}
                        </p>
                        {joiningCatalog.reason && !joiningCatalog.pending && (
                          <button
                            type="button"
                            className="conversation-agents-row"
                            onClick={() => requestCatalog(joiningCatalog.refresh)}
                          >
                            Check saved context again
                          </button>
                        )}
                        {joiningCatalog.catalog?.retainedAvailability === 'unavailable' && (
                          <p className="conversation-agents-explanation">
                            Retained artifact versions are unavailable here.
                          </p>
                        )}
                        {joiningCatalog.catalog?.unversionedRetainedReferences && (
                          <p className="conversation-agents-explanation">
                            Some artifact references have no exact saved version. Choose a saved
                            version explicitly to include it.
                          </p>
                        )}
                      </>
                    )}
                    {setup.messageIds.length === 0 && setup.artifacts.length === 0 && (
                      <p>Joining brief only.</p>
                    )}
                  </>
                )}
                <label className="conversation-agent-field">
                  Purpose
                  <input
                    value={setup.purpose}
                    maxLength={4000}
                    placeholder="What should this agent help with?"
                    onChange={(e) => setSetup((s) => ({ ...s, purpose: e.target.value }))}
                  />
                </label>
                <p className="conversation-agents-explanation">
                  Standard boot, agent guidance and repository instructions stay separate from
                  shared conversation context.
                </p>
                {profileReason && <p role="alert">{profileReason}</p>}
                {setup.name && !nameValid && (
                  <p role="alert">
                    Choose a unique name using letters, numbers, underscores or hyphens. “all” is
                    reserved.
                  </p>
                )}
                {!joiningOwner && (
                  <p role="status" ref={setupStatus} tabIndex={-1}>
                    {unavailable}
                  </p>
                )}
                {!joiningOwner && onRetryJoiningSetup && (
                  <button
                    type="button"
                    onClick={() => {
                      restoreSetupFocus.current = true;
                      onRetryJoiningSetup();
                    }}
                  >
                    Check setup again
                  </button>
                )}
              </>
            )}
            {view === 'review' && (
              <ConversationJoiningReview
                flow={joining}
                agents={agents}
                onAgents={() => setView('agents')}
              />
            )}
          </div>
          {view === 'review' ? (
            <ConversationJoiningReviewActions
              flow={joining}
              onBack={() => setView(joining.locked ? 'agents' : 'add')}
            />
          ) : (
            <footer className="conversation-agents-footer">
              {view === 'agents' ? (
                <>
                  <button type="button" onClick={() => setOpen(false)}>
                    Done
                  </button>
                  <button
                    type="button"
                    className="conversation-agents-primary"
                    ref={addAgentTrigger}
                    onClick={() => {
                      if (joining.join?.state === 'linked') {
                        const fresh = joining.startNew();
                        setView(fresh ? 'add' : 'review');
                        if (fresh) onAddAgent?.();
                      } else {
                        const resume = joining.locked || joining.hasAttemptFor(reviewSetup);
                        setView(resume ? 'review' : 'add');
                        if (!resume) onAddAgent?.();
                      }
                    }}
                  >
                    Add agent
                  </button>
                </>
              ) : (
                <>
                  {view === 'add' && <small>Fresh session · starts with a prompt.</small>}
                  <button
                    type="button"
                    onClick={view === 'add' ? returnToAgents : () => setView('agents')}
                  >
                    {view === 'add' ? 'Cancel' : 'Back to Agents'}
                  </button>
                  {view === 'add' && (
                    <button
                      type="button"
                      className="conversation-agents-primary"
                      disabled={
                        !joiningOwner ||
                        joining.locked ||
                        !!joining.pending ||
                        (joiningCatalog && !joiningCatalog.catalog?.sourceRepository) ||
                        !nameValid ||
                        !setup.purpose.trim() ||
                        !setup.selection?.accountId ||
                        !!profileReason
                      }
                      title={!joiningOwner ? unavailable : undefined}
                      onClick={() => {
                        setView('review');
                        void joining.prepare(
                          reviewSetup,
                          joiningOwner?.kind === 'application'
                            ? initialConversationJoiningBrief({
                                name: setup.name,
                                purpose: setup.purpose,
                                conversationTitle,
                                participantNames: agents.map((agent) => agent.name),
                              })
                            : undefined,
                        );
                      }}
                    >
                      Review joining brief
                    </button>
                  )}
                </>
              )}
            </footer>
          )}
        </ConversationAgentsDialog>
      )}
    </>
  );
}
