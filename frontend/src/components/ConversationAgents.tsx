import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  DEFAULT_MITZO_PROFILE_ID,
  DEFAULT_MITZO_PROFILE_REVISION,
  type FinishedMessage,
} from '@mitzo/protocol';
import type {
  ConversationAgentSetup,
  ConversationJoiningOwner,
} from '../lib/conversation-joining-review';
import { useConversationJoiningReview } from '../hooks/useConversationJoiningReview';
import {
  ConversationJoiningReview,
  ConversationJoiningReviewActions,
} from './ConversationJoiningReview';
import { HomeDialog } from './HomeDialog';
import { useMotionPresence } from '../hooks/useMotionPresence';
import { UiIcon } from './UiIcon';
import { AccountModelPicker } from './AccountModelPicker';
import { ChatAgentProfilePicker } from './ChatAgentProfilePicker';
import './ConversationAgents.css';
import '../styles/header-actions.css';
import { ConversationRepositoryPicker } from './ConversationRepositoryPicker';
import { QuickSettingsContext, type SettingsDestination } from '../lib/quick-settings-context';
import { QuickSettingsField } from './QuickChatSettings';

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
const defaultAgent = {
  kind: 'builtin' as const,
  profileId: DEFAULT_MITZO_PROFILE_ID,
  revision: DEFAULT_MITZO_PROFILE_REVISION,
};
const initial = (): ConversationAgentSetup => ({
  name: '',
  purpose: '',
  context: 'conversation_so_far',
  messageIds: [],
  artifacts: [],
  runOn: 'local',
  selection: null,
  agent: defaultAgent,
});

/** Presentation shared by ordinary and retained conversations. No allocation or dispatch.
 * A missing policy/join owner is unavailable, never a local simulation of acceptance.
 */
export function ConversationAgents(props: {
  scope: string;
  agents: ConversationAgent[];
  messages: FinishedMessage[];
  repository?: string;
  compact?: boolean;
  leading?: ReactNode;
  actions?: ReactNode;
  settings?: ReactNode;
  onPreview?(id: string): void;
  onDraftProfile?(id: string): void;
  unavailableReason?: string;
  renderPreview?(agent: ConversationAgent): ReactNode;
  onPolicyChange?(id: string, policy: { reads: boolean; replies: boolean }): void;
  /** Confirmed policy state and explicit recovery controls from the existing owner. */
  policyFeedback?: ReactNode;
  policyUnavailableReason?: string;
  /** Supplied only when real source, capacity and ordinary preparation owners exist. */
  joiningOwner?: ConversationJoiningOwner;
}) {
  // A route change synchronously retires the dialog, callbacks and private setup.
  // Participant editors belong to this dialog. Portals retain React context,
  // so inheriting the source chat's navigation would move them into its settings.
  return (
    <QuickSettingsContext.Provider value={null}>
      <ConversationAgentsBody key={props.scope} {...props} />
    </QuickSettingsContext.Provider>
  );
}
/** The query box is the available conversation width, before the header's own gutter. */
function ParticipantHeaderFrame({ compact, children }: { compact?: boolean; children: ReactNode }) {
  return compact ? children : <div className="conversation-participants-container">{children}</div>;
}
function ConversationAgentsBody({
  agents,
  messages,
  repository,
  compact,
  leading,
  actions,
  settings,
  onPreview,
  onDraftProfile,
  unavailableReason,
  renderPreview,
  onPolicyChange,
  policyFeedback,
  policyUnavailableReason,
  joiningOwner,
}: Parameters<typeof ConversationAgents>[0]) {
  const [view, setView] = useState<
    'agents' | 'add' | 'review' | 'settings' | 'preview' | 'details'
  >('agents');
  const [open, setOpen] = useState(false);
  const [setupPage, setSetupPage] = useState<SettingsDestination | null>(null);
  const setupFields = useRef<HTMLDivElement>(null);
  const previousSetupPage = useRef<SettingsDestination | null>(null);
  const reviewReasonId = useId();
  const compactSetup = joiningOwner?.kind === 'application';
  useEffect(() => {
    if (!open) setSetupPage(null);
  }, [open]);
  const { ref: dialogMotionRef, present } = useMotionPresence(open, 'fade');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewAgent = agents.find((agent) => agent.id === previewId);
  const [profileReason, setProfileReason] = useState<string>();
  const joining = useConversationJoiningReview(joiningOwner, () => {
    setOpen(false);
    setView('agents');
    setSetup(initial());
    setProfileReason(undefined);
  });
  const [setup, setSetup] = useState(() =>
    joining.setup ? structuredClone(joining.setup) : initial(),
  );
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
  const reviewReason = !joiningOwner
    ? (unavailableReason ?? 'Adding an agent is unavailable. Your setup stays here.')
    : !setup.name
      ? 'Give this agent a name.'
      : !nameValid
        ? 'Choose a unique name using letters, numbers, underscores or hyphens. “all” is reserved.'
        : !setup.purpose.trim()
          ? 'Tell this agent what to help with.'
          : !setup.selection?.accountId || !setup.selection.model.trim()
            ? 'Choose an account and model.'
            : profileReason
              ? profileReason
              : joiningOwner.kind === 'application' &&
                  (!setup.repositoryWorkspaceId || !setup.permissionMode)
                ? 'Choose a repository in Where it runs.'
                : undefined;
  const updateSelection = (selection: ConversationAgentSetup['selection']) =>
    setSetup((s) => ({
      ...s,
      selection,
      ...(s.selection?.accountId !== selection?.accountId || s.selection?.model !== selection?.model
        ? { repositoryWorkspaceId: undefined, permissionMode: undefined }
        : {}),
    }));
  useLayoutEffect(() => {
    if (setupPage) setupFields.current?.querySelector<HTMLElement>('.quick-settings-back')?.focus();
    else if (previousSetupPage.current)
      setupFields.current
        ?.querySelector<HTMLElement>(`[data-quick-setting="${previousSetupPage.current.key}"]`)
        ?.focus();
    previousSetupPage.current = setupPage;
  }, [setupPage]);
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
  const selectable = messages.filter((m) =>
    m.blocks.some((b) => b.blockType === 'text' && b.content),
  );
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
            className={`conversation-participants-trigger${compact ? ' header-action' : ''}`}
            aria-label={`Agents${names ? ', ' + names : ''}`}
            aria-expanded={open}
            onClick={(event) => {
              event.currentTarget.focus();
              setView('agents');
              setOpen(true);
            }}
          >
            <UiIcon name={compact || agents.length <= 1 ? 'bot' : 'agents'} />
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
            {!compact && <UiIcon name="down" />}
          </button>
          {actions}
        </div>
      </ParticipantHeaderFrame>
      {present && (
        <HomeDialog
          title={title}
          closeLabel="Close Agents"
          inactive={!open}
          onClose={() => setOpen(false)}
          className={`conversation-agents-dialog${view === 'review' ? ' conversation-joining-dialog' : ''}`}
          onBack={
            view === 'add' && setupPage
              ? () => setSetupPage(null)
              : view === 'review'
                ? () => setView(joining.locked ? 'agents' : 'add')
                : undefined
          }
          backLabel={view === 'add' ? 'Back to agent setup' : 'Back from joining review'}
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
                          ref={(input) => {
                            if (input) input.indeterminate = !a.policy;
                          }}
                          aria-checked={!a.policy ? 'mixed' : undefined}
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
                          ref={(input) => {
                            if (input) input.indeterminate = !a.policy;
                          }}
                          aria-checked={!a.policy ? 'mixed' : undefined}
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
                    {!a.policy && <p role="status">Sharing settings have not been checked.</p>}
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
                  <p>
                    You can still send selected earlier messages to an agent later. These settings
                    control automatic sharing and replies.
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
              <QuickSettingsContext.Provider
                value={
                  compactSetup
                    ? { page: setupPage, summaryRoot: null, navigate: setSetupPage }
                    : null
                }
              >
                <div
                  ref={setupFields}
                  className={`workspace-controls--quick conversation-agent-setup${compactSetup ? ' conversation-agent-setup--compact' : ''}`}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && setupPage) {
                      event.preventDefault();
                      event.stopPropagation();
                      setSetupPage(null);
                    }
                  }}
                >
                  {setupPage && (
                    <button
                      type="button"
                      className="quick-settings-back"
                      onClick={() => setSetupPage(null)}
                    >
                      <UiIcon name="back" /> {setupPage.title}
                    </button>
                  )}
                  <div
                    className="conversation-agent-identity"
                    hidden={!!setupPage}
                    inert={!!setupPage}
                  >
                    <label className="conversation-agent-field">
                      Name in this chat
                      <input
                        required
                        value={setup.name}
                        maxLength={24}
                        onChange={(e) => setSetup((s) => ({ ...s, name: e.target.value }))}
                      />
                    </label>
                    <label className="conversation-agent-field">
                      Purpose
                      <input
                        required
                        value={setup.purpose}
                        maxLength={4000}
                        placeholder="What should this agent help with?"
                        onChange={(e) => setSetup((s) => ({ ...s, purpose: e.target.value }))}
                      />
                    </label>
                  </div>
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
                    presentation={compactSetup ? 'choices' : 'select'}
                    onChange={(agent, reason) => {
                      setSetup((s) => ({
                        ...s,
                        agent: reason && !agent ? s.agent : (agent ?? defaultAgent),
                      }));
                      setProfileReason(reason);
                    }}
                  />
                  <AccountModelPicker
                    sessionId={null}
                    preferredModel=""
                    draftOnly
                    presentation="settings"
                    defaultsControl={compactSetup ? null : undefined}
                    initialSelection={setup.selection ?? undefined}
                    onDraftSelectionChange={updateSelection}
                    onChange={updateSelection}
                  />
                  <QuickSettingsField
                    page="execution"
                    title="Where it runs"
                    value={`${setup.runOn === 'local' ? 'Mac host' : 'OpenShell'}${joiningOwner?.kind === 'application' && !setup.repositoryWorkspaceId ? ' · Choose repository' : ''}`}
                  >
                    <fieldset className="conversation-agent-run-on">
                      <legend>Run on</legend>
                      {(['local', 'openshell'] as const).map((runOn) => (
                        <label key={runOn}>
                          <input
                            type="radio"
                            name="fresh-agent-run-on"
                            value={runOn}
                            checked={setup.runOn === runOn}
                            onChange={() =>
                              setSetup((s) => ({
                                ...s,
                                runOn,
                                repositoryWorkspaceId: undefined,
                                permissionMode: undefined,
                              }))
                            }
                          />
                          <UiIcon name={runOn === 'local' ? 'laptop' : 'box'} />
                          <span>{runOn === 'local' ? 'Mac host' : 'OpenShell'}</span>
                        </label>
                      ))}
                    </fieldset>
                    <div className="conversation-agent-field">
                      <span>Repository</span>
                      <strong>{repository || 'Not selected'}</strong>
                    </div>
                    {joiningOwner?.kind === 'application' && (
                      <ConversationRepositoryPicker
                        setup={setup}
                        onChange={(values) => setSetup((s) => ({ ...s, ...values }))}
                      />
                    )}
                  </QuickSettingsField>
                  <QuickSettingsField
                    page="more"
                    title="Starting context"
                    value={
                      setup.context === 'conversation_so_far'
                        ? 'Conversation so far'
                        : `${setup.messageIds.length} messages · ${setup.artifacts.length} artifacts`
                    }
                  >
                    <label className="conversation-agent-field">
                      Context
                      <select
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
                          {selectable.length === 0 && <p>No messages yet.</p>}
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
                                <small>
                                  {m.role === 'user'
                                    ? 'You'
                                    : m.symposiumProvenance && 'seatLabel' in m.symposiumProvenance
                                      ? m.symposiumProvenance.seatLabel
                                      : 'Agent'}
                                </small>
                                {m.blocks
                                  .filter((b) => b.blockType === 'text')
                                  .map((b) => b.content)
                                  .join('\n')}
                              </span>
                            </label>
                          ))}
                        </fieldset>
                        {joiningOwner?.artifacts ? (
                          <fieldset className="conversation-context-selection">
                            <legend>Artifacts</legend>
                            {joiningOwner.artifacts.length === 0 && (
                              <p>No artifacts in this conversation.</p>
                            )}
                            {joiningOwner.artifacts.map((artifact) => (
                              <label
                                key={`${artifact.artifactId}:${artifact.revision}:${artifact.sha256}`}
                              >
                                <input
                                  type="checkbox"
                                  checked={setup.artifacts.some(
                                    (a) =>
                                      a.artifactId === artifact.artifactId &&
                                      a.revision === artifact.revision &&
                                      a.sha256 === artifact.sha256,
                                  )}
                                  onChange={(event) =>
                                    setSetup((s) => ({
                                      ...s,
                                      artifacts: event.target.checked
                                        ? [
                                            ...s.artifacts,
                                            {
                                              artifactId: artifact.artifactId,
                                              revision: artifact.revision,
                                              sha256: artifact.sha256,
                                            },
                                          ]
                                        : s.artifacts.filter(
                                            (a) =>
                                              a.artifactId !== artifact.artifactId ||
                                              a.revision !== artifact.revision ||
                                              a.sha256 !== artifact.sha256,
                                          ),
                                    }))
                                  }
                                />
                                <span>
                                  {artifact.title}
                                  <small>Saved version {artifact.revision}</small>
                                </span>
                              </label>
                            ))}
                          </fieldset>
                        ) : (
                          <p className="conversation-agents-explanation">
                            Saved artifact versions are not available for selection yet.
                          </p>
                        )}
                        {setup.messageIds.length === 0 && setup.artifacts.length === 0 && (
                          <p>Joining brief only.</p>
                        )}
                      </>
                    )}
                  </QuickSettingsField>
                  {profileReason && <p role="alert">{profileReason}</p>}
                  {!joiningOwner && <p role="status">{unavailable}</p>}
                </div>
              </QuickSettingsContext.Provider>
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
                    onClick={() => {
                      if (joining.join?.state === 'linked') {
                        setView(joining.startNew() ? 'add' : 'review');
                      } else
                        setView(joining.locked || joining.hasAttemptFor(setup) ? 'review' : 'add');
                    }}
                  >
                    Add agent
                  </button>
                </>
              ) : view === 'add' && setupPage ? (
                <button type="button" onClick={() => setSetupPage(null)}>
                  Done
                </button>
              ) : (
                <>
                  {view === 'add' && (
                    <>
                      <small>Fresh session · starts with a prompt.</small>
                      <p className="conversation-setup-reason" id={reviewReasonId} role="status">
                        {reviewReason}
                      </p>
                    </>
                  )}
                  <button type="button" onClick={() => setView('agents')}>
                    {view === 'add' ? 'Cancel' : 'Back to Agents'}
                  </button>
                  {view === 'add' && (
                    <button
                      type="button"
                      disabled={!!reviewReason}
                      aria-describedby={reviewReasonId}
                      onClick={() => {
                        if (!setup.selection?.accountId || !setup.selection.model.trim()) return;
                        setView('review');
                        void joining.prepare(setup);
                      }}
                    >
                      Review joining brief
                    </button>
                  )}
                </>
              )}
            </footer>
          )}
        </HomeDialog>
      )}
    </>
  );
}
